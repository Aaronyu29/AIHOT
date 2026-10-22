#!/usr/bin/env python3
"""Install a verified CI image on the existing Compose host; never build there."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time


def verify_bundle(bundle, sha, run_id):
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Invalid commit SHA')
    expected_files = {'image.tar.gz', 'install-ci-release.py', 'release.json'}
    hashes = {}
    for line in (bundle / 'SHA256SUMS').read_text().splitlines():
        digest, name = line.split(maxsplit=1)
        name = name.strip()
        if name not in expected_files or name in hashes or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise ValueError('Invalid checksum manifest')
        with (bundle / name).open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
                raise ValueError('Checksum mismatch: ' + name)
        hashes[name] = digest
    if set(hashes) != expected_files:
        raise ValueError('Incomplete checksum manifest')
    release = json.loads((bundle / 'release.json').read_text())
    if release['sha'] != sha or str(release['runId']) != str(run_id):
        raise ValueError('Artifact does not match the successful CI run')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', release['imageId']):
        raise ValueError('Invalid image identity')
    return release


def install(root, bundle, sha, run_id):
    release = verify_bundle(bundle, sha, run_id)
    os.chdir(root)

    def run(*args, **kwargs):
        return subprocess.run(args, check=True, **kwargs)

    def read(*args):
        return subprocess.check_output(args, text=True).strip()

    # Also prevents two deployments from changing tags or environment concurrently.
    import fcntl
    with (root / '.data' / 'ci-deploy.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if read('git', 'status', '--porcelain'):
            raise RuntimeError('Production checkout is dirty')
        before = read('git', 'rev-parse', 'HEAD')
        run('git', 'fetch', 'origin', 'main')
        if read('git', 'rev-parse', 'origin/main') != sha:
            raise RuntimeError('main changed; select its latest successful CI run')
        run('git', 'merge-base', '--is-ancestor', before, sha)
        old = {role: json.loads(read('docker', 'inspect', 'aihot-' + role + '-1'))[0]
               for role in ['api', 'worker', 'web', 'db', 'caddy']}
        run('docker', 'load', '-i', str(bundle / 'image.tar.gz'))
        image = 'aihot-app:' + sha
        loaded = json.loads(read('docker', 'image', 'inspect', image))[0]
        if loaded['Id'] != release['imageId'] or loaded['Config']['Labels'].get('org.opencontainers.image.revision') != sha:
            raise RuntimeError('Loaded image does not match CI')
        backup = root / '.data' / 'deployments' / ('ci-' + str(run_id) + '-' + str(time.time_ns()))
        backup.mkdir(parents=True, mode=0o700)
        shutil.copy2(root / '.env', backup / 'env.before')
        os.chmod(backup / 'env.before', 0o600)
        (backup / 'identity.json').write_text(json.dumps({'before': before, 'release': release, 'containers': {
            name: {'id': d['Id'], 'image': d['Image']} for name, d in old.items()}}))
        (backup / 'compose.before.yml').write_bytes((root / 'docker-compose.yml').read_bytes())
        # Each role may have a different previous image (e.g. an earlier web-only deployment).
        rollback = {'services': {role: {'image': old[role]['Image']} for role in ['api', 'worker', 'web']}}
        (backup / 'rollback.json').write_text(json.dumps(rollback))
        changed = False
        try:
            # Keep serving pages while paid calls/backup jobs drain using the existing 515s grace period.
            run('docker', 'compose', 'stop', 'worker')
            with (backup / 'database.dump').open('wb') as stream:
                run('docker', 'exec', 'aihot-db-1', 'pg_dump', '-U', 'aihot', '-d', 'aihot', '-Fc', stdout=stream)
            os.chmod(backup / 'database.dump', 0o600)
            with (backup / 'database.dump').open('rb') as stream:
                run('docker', 'exec', '-i', 'aihot-db-1', 'pg_restore', '--list', stdin=stream, stdout=subprocess.DEVNULL)
            run('git', 'merge', '--ff-only', sha)
            changed = True
            env = (root / '.env').read_text()
            lines = [line for line in env.splitlines() if not line.startswith('AIHOT_RELEASE=')]
            staged = root / '.env.ci-next'
            staged.write_text('\n'.join(lines + ['AIHOT_RELEASE=' + sha]) + '\n')
            os.chmod(staged, 0o600)
            os.replace(staged, root / '.env')
            run('docker', 'tag', image, 'aihot-app')
            # Only migrations: never reseed production sources or rebuild the image.
            run('docker', 'compose', 'run', '--rm', '--no-deps', '--pull', 'never', 'setup', 'node', 'scripts/migrate.ts')
            run('docker', 'compose', 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api', 'web', 'worker')
            for attempt in range(60):
                probe = subprocess.run(['docker', 'exec', 'aihot-web-1', 'node', '-e',
                    "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if probe.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError('Health check failed')
            run('docker', 'exec', 'aihot-web-1', 'node', 'scripts/smoke.ts', '--base', 'http://127.0.0.1:3000')
            for role in ['api', 'worker', 'web', 'db', 'caddy']:
                d = json.loads(read('docker', 'inspect', 'aihot-' + role + '-1'))[0]
                if not d['State']['Running']:
                    raise RuntimeError('Service stopped: ' + role)
                if role in ['db', 'caddy']:
                    if d['Id'] != old[role]['Id']:
                        raise RuntimeError('Unexpected infrastructure restart: ' + role)
                elif d['Image'] != release['imageId'] or d['Config']['Labels'].get('org.opencontainers.image.revision') != sha:
                    raise RuntimeError('Release identity mismatch: ' + role)
            (backup / 'success.json').write_text(json.dumps(release))
            print(json.dumps({'deployed': sha, 'runId': run_id, 'imageId': release['imageId'], 'backup': str(backup)}))
        except BaseException:
            shutil.copy2(backup / 'env.before', root / '.env')
            if changed:
                run('git', 'checkout', '--detach', before)
            run('docker', 'tag', old['api']['Image'], 'aihot-app')
            run('docker', 'compose', '-f', str(backup / 'compose.before.yml'), '-f', str(backup / 'rollback.json'),
                '--project-directory', str(root), '-p', 'aihot', 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api', 'web', 'worker')
            # Online migrations are additive. Never automatically overwrite the live DB with a dump.
            raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('/opt/aihot'))
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args()
    install(args.root.resolve(), args.bundle.resolve(), args.sha, args.run_id)
