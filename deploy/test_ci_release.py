"""Reject corrupted or mismatched artifacts before any production action."""
import hashlib
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install-ci-release.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
client_spec = importlib.util.spec_from_file_location('deploy_client', Path(__file__).parents[1] / 'scripts' / 'deploy-ci.py')
client = importlib.util.module_from_spec(client_spec)
client_spec.loader.exec_module(client)


class BundleTests(unittest.TestCase):
    def test_only_the_completed_successful_main_check_can_release(self):
        repo, sha = 'owner/site', 'a' * 40
        workflow = {'id': 100}
        run = {'head_sha': sha, 'head_branch': 'main', 'head_repository': {'full_name': repo},
               'status': 'completed', 'conclusion': 'success', 'workflow_id': 100, 'event': 'push'}
        client.validate_run(run, workflow, sha, repo)
        manual = {**run, 'event': 'workflow_dispatch'}
        client.validate_run(manual, workflow, sha, repo)
        rejected = [
            {'conclusion': 'failure'}, {'conclusion': 'cancelled'}, {'conclusion': 'skipped'},
            {'status': 'in_progress'}, {'head_branch': 'feature'}, {'head_sha': 'b' * 40},
            {'head_repository': {'full_name': 'fork/site'}}, {'head_repository': None},
            {'workflow_id': 101}, {'event': 'pull_request'}, {'event': 'pull_request_target'},
        ]
        for change in rejected:
            with self.subTest(change=change), self.assertRaises(ValueError):
                client.validate_run({**deepcopy(run), **change}, workflow, sha, repo)

    def test_verified_bundle_and_rejections(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sha = 'a' * 40
            release = {'sha': sha, 'runId': '42', 'imageId': 'sha256:' + 'b' * 64}
            (root / 'image.tar.gz').write_bytes(b'test image')
            (root / 'install-ci-release.py').write_text('# test installer')
            (root / 'release.json').write_text(json.dumps(release))
            names = ['image.tar.gz', 'install-ci-release.py', 'release.json']
            manifest = '\n'.join(hashlib.sha256((root / name).read_bytes()).hexdigest() + '  ' + name for name in names)
            (root / 'SHA256SUMS').write_text(manifest)
            self.assertEqual(installer.verify_bundle(root, sha, '42'), release)
            for bad_sha, bad_run in [('c' * 40, '42'), (sha, '43')]:
                with self.assertRaises(ValueError):
                    installer.verify_bundle(root, bad_sha, bad_run)
            (root / 'image.tar.gz').write_bytes(b'corrupted')
            with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
                installer.verify_bundle(root, sha, '42')
            (root / 'SHA256SUMS').write_text('d' * 64 + '  ../outside')
            with self.assertRaisesRegex(ValueError, 'Invalid checksum'):
                installer.verify_bundle(root, sha, '42')


if __name__ == '__main__':
    unittest.main()
