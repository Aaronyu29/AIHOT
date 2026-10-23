#!/usr/bin/env python3
"""Deploy the latest main commit only from its successful GitHub Actions image."""
import argparse
import importlib.util
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile


def validate_run(run, workflow, sha, repo):
    """A workflow name alone is insufficient: only current main's full Check may release."""
    if (run.get('head_sha') != sha or run.get('head_branch') != 'main'
            or (run.get('head_repository') or {}).get('full_name') != repo
            or run.get('status') != 'completed' or run.get('conclusion') != 'success'
            or run.get('workflow_id') != workflow['id'] or run.get('event') not in ['push', 'workflow_dispatch']):
        raise ValueError('Run is not the successful Check workflow for current main')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', default='Aaronyu29/AIHOT')
    parser.add_argument('--host', required=True, help='SSH user@host; host key must already be trusted')
    parser.add_argument('--identity', type=Path, required=True)
    parser.add_argument('--known-hosts', type=Path, help='Optional pinned SSH host keys (otherwise use OpenSSH defaults)')
    parser.add_argument('--root', default='/opt/aihot')
    parser.add_argument('--run-id', help='Defaults to the latest successful Check run on current main')
    args = parser.parse_args()
    if args.host.startswith('-') or not args.root.startswith('/'):
        parser.error('Invalid host or absolute server root')

    def output(*command):
        return subprocess.check_output(command, text=True).strip()

    def api(path):
        return json.loads(output('gh', 'api', 'repos/' + args.repo + '/' + path))

    sha = api('commits/main')['sha']
    if args.run_id:
        run = api('actions/runs/' + args.run_id)
    else:
        runs = api('actions/workflows/check.yml/runs?branch=main&head_sha=' + sha + '&status=success&per_page=10')['workflow_runs']
        run = next((r for r in runs if r['event'] in ['push', 'workflow_dispatch']), None)
        if run is None:
            raise SystemExit('Latest main has no successful Check run yet; no deployment performed')
    workflow = api('actions/workflows/check.yml')
    try:
        validate_run(run, workflow, sha, args.repo)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    ssh = str(Path('C:/Windows/System32/OpenSSH/ssh.exe')) if Path('C:/Windows/System32/OpenSSH/ssh.exe').exists() else shutil.which('ssh')
    scp = str(Path('C:/Windows/System32/OpenSSH/scp.exe')) if Path('C:/Windows/System32/OpenSSH/scp.exe').exists() else shutil.which('scp')
    options = ['-i', str(args.identity.resolve()), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes']
    if args.known_hosts:
        options += ['-o', 'UserKnownHostsFile=' + str(args.known_hosts.resolve())]
    # Files are removed locally after use; keep the remote bundle for release audit and rollback.
    with tempfile.TemporaryDirectory(prefix='aihot-ci-') as folder:
        bundle = Path(folder)
        subprocess.run(['gh', 'run', 'download', str(run['id']), '--repo', args.repo,
            '--name', 'aihot-image-' + sha, '--dir', folder], check=True)
        # Use this checkout's verifier before executing anything downloaded.
        spec = importlib.util.spec_from_file_location('installer', Path(__file__).resolve().parents[1] / 'deploy' / 'install-ci-release.py')
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        installer.verify_bundle(bundle, sha, run['id'])
        if api('commits/main')['sha'] != sha:
            raise SystemExit('main changed during download; retry with its successful CI run')
        remote = output(ssh, *options, args.host, 'mktemp -d /tmp/aihot-ci-XXXXXXXX')
        if not remote.startswith('/tmp/aihot-ci-') or '\n' in remote:
            raise RuntimeError('Unexpected staging path')
        subprocess.run([scp, *options, *[str(bundle / name) for name in ['image.tar.gz', 'release.json', 'SHA256SUMS', 'install-ci-release.py']],
            args.host + ':' + remote + '/'], check=True)
        print('Deploying CI run ' + str(run['id']) + ', commit ' + sha, flush=True)
        subprocess.run([ssh, *options, args.host, shlex.join(['sudo', '-n', 'python3', remote + '/install-ci-release.py',
            '--root', args.root, '--bundle', remote, '--sha', sha, '--run-id', str(run['id'])])], check=True)


if __name__ == '__main__':
    main()
