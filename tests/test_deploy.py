import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('preflight', ROOT / 'scripts/deploy_preflight.py')
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)
def load_helper(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

cleanup = load_helper('cleanup_releases')
snapshot = load_helper('snapshot_rollback')


class CleanupTests(unittest.TestCase):
    def test_only_owned_old_objects_removed_and_in_use_images_survive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            incoming = root / '.deploy/incoming'
            incoming.mkdir(parents=True)
            shas = [str(i) * 40 for i in range(1, 7)]
            rollback = 'nodemail:rollback-' + shas[0] + '-123-456'
            refs = ['nodemail:' + s for s in shas] + [rollback]
            unknown = ['nodemail:latest', 'nodemail:rollback-manual', 'other:' + shas[5]]
            images = {ref: {'Id': 'image-' + str(i), 'Created': str(10-i)} for i, ref in enumerate(refs)}
            images[rollback]['Created'] = '99'
            for i, sha in enumerate(shas):
                path = incoming / sha
                path.mkdir()
                (path / 'nodemail-image.tar.gz.sha256').touch()
                import os
                os.utime(path, (100-i, 100-i))
            (incoming / 'operator-recovery').mkdir()
            # SHA-looking unknown directories without the transfer manifest survive.
            unknown_dir = incoming / ('f' * 40)
            unknown_dir.mkdir()
            calls = []
            def docker(*args):
                calls.append(args)
                if args == ('ps', '-aq'): return 'other-container'
                if args[:1] == ('inspect',): return json.dumps([{'Image': images[refs[4]]['Id']}])
                if args[:2] == ('image', 'ls'): return '\n'.join(refs + unknown)
                if args[:2] == ('image', 'inspect'): return json.dumps([images[r] for r in args[2:]])
                if args[:2] == ('ps', '-aq'): return 'new-user' if args[-1] == 'ancestor=' + images[refs[5]]['Id'] else ''
                if args[:2] == ('image', 'rm'): return ''
                raise AssertionError(args)
            with patch.object(cleanup, 'docker', side_effect=docker):
                cleanup.cleanup(root, shas[0], rollback)
            removed = [args[2] for args in calls if args[:2] == ('image', 'rm')]
            self.assertEqual(set(removed), {refs[2], refs[3]})
            self.assertTrue(all((incoming / sha).exists() for sha in shas[:3]))
            self.assertTrue(all(not (incoming / sha).exists() for sha in shas[3:]))
            self.assertTrue(unknown_dir.exists())
            self.assertTrue((incoming / 'operator-recovery').exists())
            self.assertFalse(any('prune' in arg for args in calls for arg in args))
            self.assertFalse(any('--force' in args or '-f' in args for args in calls))

    def test_removal_failure_is_warning_and_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            refs = ['nodemail:' + str(i)*40 for i in range(1,5)]
            rollback = 'nodemail:rollback-' + '1'*40 + '-1-1'
            refs.append(rollback)
            def docker(*args):
                if args[:1] == ('ps',): return ''
                if args[:2] == ('image','ls'): return '\n'.join(refs)
                if args[:2] == ('image','inspect'): return json.dumps([{'Id':r,'Created':str(10-refs.index(r))} for r in args[2:]])
                raise RuntimeError('fixture removal denied')
            import io
            from contextlib import redirect_stdout
            out=io.StringIO()
            with patch.object(cleanup,'docker',side_effect=docker), redirect_stdout(out):
                cleanup.cleanup(root,'1'*40,rollback)
            self.assertIn('WARNING',out.getvalue())
            with self.assertRaises(ValueError): cleanup.cleanup(root,'invalid',rollback)


class SnapshotTests(unittest.TestCase):
    def test_scrubs_secrets_and_requires_compose_to_reproduce_runtime(self):
        live=[{'Config':{'Env':['PATH=/usr/bin','NODE_ENV=production','MYSQL_PASSWORD=synthetic-secret','GUEST_SESSION_SECRET=synthetic-session']}}]
        config={'services':{'nodemail':{'environment':{'MYSQL_PASSWORD':'synthetic-secret','GUEST_SESSION_SECRET':'synthetic-session'}}}}
        saved=[{'Config':{'Env':['PATH=/usr/bin','NODE_ENV=production','MYSQL_PASSWORD=','GUEST_SESSION_SECRET=']}}]
        with patch.object(snapshot,'read_json',side_effect=[live,config,saved]), patch.object(snapshot.subprocess,'run') as run:
            snapshot.snapshot('fixture','fixture-tag',[])
            command=run.call_args.args[0]
            self.assertIn('--pause=true',command)
            self.assertIn('ENV MYSQL_PASSWORD=',command)
            self.assertNotIn('synthetic-secret',' '.join(command))
        config['services']['nodemail']['environment']['MYSQL_PASSWORD']='different'
        with patch.object(snapshot,'read_json',side_effect=[live,config]), patch.object(snapshot.subprocess,'run') as run:
            with self.assertRaises(ValueError): snapshot.snapshot('fixture','fixture-tag',[])
            run.assert_not_called()

    def test_snapshot_with_any_remaining_secret_is_rejected(self):
        with patch.object(snapshot,'read_json',side_effect=[
            [{'Config':{'Env':['MYSQL_PASSWORD=synthetic']}}],
            {'services':{'nodemail':{'environment':{'MYSQL_PASSWORD':'synthetic'}}}},
            [{'Config':{'Env':['MYSQL_PASSWORD=synthetic']}}],
        ]), patch.object(snapshot.subprocess,'run'):
            with self.assertRaises(ValueError): snapshot.snapshot('fixture','tag',[])

    def test_legacy_container_config_cannot_hide_a_remaining_secret(self):
        with patch.object(snapshot,'read_json',side_effect=[
            [{'Config':{'Env':['MYSQL_PASSWORD=synthetic']}}],
            {'services':{'nodemail':{'environment':{'MYSQL_PASSWORD':'synthetic'}}}},
            [{'Config':{'Env':['MYSQL_PASSWORD=']},'ContainerConfig':{'Env':['MYSQL_PASSWORD=synthetic']}}],
        ]), patch.object(snapshot.subprocess,'run'):
            with self.assertRaises(ValueError): snapshot.snapshot('fixture','tag',[])


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.live = {
            'Config': {'Labels': {
                'com.docker.compose.project.working_dir': '/opt/nodemail',
                'com.docker.compose.project.config_files': '/opt/nodemail/docker-compose.yml',
            }, 'Env': ['MYSQL_HOST=mysql', 'MYSQL_PASSWORD=fixture-only', 'MAIL_ATTACHMENT_DIR=/app/data/mail-attachments']},
            'Mounts': [{'Destination': '/app/data/mail-attachments', 'Type': 'volume', 'Name': 'existing-mail-data', 'RW': True}],
            'State': {'Running': True, 'Restarting': False, 'Health': {'Status': 'healthy'}},
        }
        self.config = {'services': {'nodemail': {
            'container_name': 'nodemail',
            'volumes': [{'type': 'volume', 'source': 'mail', 'target': '/app/data/mail-attachments'}],
            'environment': {'MYSQL_HOST': 'mysql', 'MYSQL_PASSWORD': 'fixture-only', 'MAIL_ATTACHMENT_DIR': '/app/data/mail-attachments'},
            'healthcheck': {'test': ['CMD', 'check /api/health and 2525']},
        }}, 'volumes': {'mail': {'name': 'existing-mail-data'}}}

    def check(self):
        preflight.validate_layout(self.live, self.config, '/opt/nodemail')

    def test_existing_data_bindings_pass(self):
        self.check()

    def test_previous_release_override_passes(self):
        self.live['Config']['Labels']['com.docker.compose.project.config_files'] += ',/opt/nodemail/.deploy/transaction.Abc123/candidate.yml'
        self.check()

    def test_unrecognized_compose_override_is_rejected(self):
        self.live['Config']['Labels']['com.docker.compose.project.config_files'] += ',/opt/other-project/override.yml'
        with self.assertRaises(ValueError):
            self.check()

    def test_attachment_volume_switch_is_rejected(self):
        self.config['volumes']['mail']['name'] = 'empty-new-volume'
        with self.assertRaises(ValueError):
            self.check()

    def test_database_or_password_switch_is_rejected(self):
        for field in ('MYSQL_HOST', 'MYSQL_PASSWORD'):
            config = copy.deepcopy(self.config)
            config['services']['nodemail']['environment'][field] = 'different'
            with self.assertRaises(ValueError):
                preflight.validate_layout(self.live, config, '/opt/nodemail')

    def test_unhealthy_baseline_is_rejected(self):
        self.live['State']['Health']['Status'] = 'unhealthy'
        with self.assertRaises(ValueError):
            self.check()

    def test_stopped_or_restarting_baseline_is_rejected_despite_old_healthy_status(self):
        for running, restarting in ((False, False), (True, True)):
            with self.subTest(running=running, restarting=restarting):
                self.live['State']['Running'] = running
                self.live['State']['Restarting'] = restarting
                with self.assertRaises(ValueError):
                    self.check()

    def test_healthcheck_requires_database_and_smtp(self):
        self.config['services']['nodemail']['healthcheck']['test'] = ['CMD', 'check open port']
        with self.assertRaises(ValueError):
            self.check()

    def test_migration_change_prevents_deployment(self):
        with patch.object(preflight.sys, 'argv', ['deploy_preflight.py', 'nodemail:candidate', 'existing']), \
             patch.object(preflight.subprocess, 'check_output', return_value='amd64\n'), \
             patch.object(preflight, 'read_json', side_effect=[
                 [self.live], self.config, {'001.sql': 'original'}, {'001.sql': 'changed'}]):
            with self.assertRaisesRegex(ValueError, 'Migration files changed'):
                preflight.main()








class DeploymentTransactionTests(unittest.TestCase):
    """Run the real shell transaction with a fake Docker daemon, never production paths."""
    def run_deploy(self, mode, previous_overlay=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sha = 'a' * 40
            incoming = root / '.deploy/incoming' / sha
            incoming.mkdir(parents=True)
            (root / '.deploy/READY').touch()
            if previous_overlay:
                (root / '.deploy/active.yml').write_text('services:\n  nodemail:\n    image: nodemail:old\n    command: ["node", "server/mail/process-manager.mjs"]\n    environment:\n      GMPAY_ENABLED: false\n      PREVIOUS_FIXTURE: preserve\n')
            (root / '.env').write_text('LOCAL_FIXTURE=untouched\n')
            (root / 'docker-compose.yml').write_text('existing compose fixture\n')
            (root / 'data').mkdir()
            (root / 'data/mail.txt').write_text('preserve mail\n')
            (incoming / 'nodemail-image.tar.gz').write_bytes(b'fixture image')
            checksum = subprocess.check_output(['sha256sum', 'nodemail-image.tar.gz'], cwd=incoming, text=True)
            (incoming / 'nodemail-image.tar.gz.sha256').write_text(checksum)
            (incoming / 'deploy_preflight.py').touch()
            for helper in ('snapshot_rollback.py', 'cleanup_releases.py', 'site_profile.py'):
                (incoming / helper).write_text((ROOT / 'scripts' / helper).read_text().replace("'/opt/nodemail'", repr(str(root))))
            if mode == 'cleanup-failure':
                (incoming / 'cleanup_releases.py').write_text('raise RuntimeError("synthetic cleanup failure")')
            (root / '.deploy/site-profile.json').write_text(json.dumps({'NODEMAIL_SITE_ORIGIN':'https://mail.example.test','NODEMAIL_PUBLIC_ORIGIN':'https://public.example.test','NODEMAIL_CONTACT_EMAIL':'admin@example.test','NODEMAIL_EMAIL_DOMAIN':'example.test','NODEMAIL_GMPAY_ORIGIN':'https://pay.example.test'}))
            source = (ROOT / 'scripts/deploy.sh').read_text().replace('DEPLOY_ROOT=/opt/nodemail', f'DEPLOY_ROOT={root}')
            script = root / 'deploy.sh'
            script.write_text(source)
            binaries = root / 'bin'
            binaries.mkdir()
            docker = binaries / 'docker'
            docker.write_text('''#!/usr/bin/env python3
import os, sys, json
from pathlib import Path
args=sys.argv[1:]; root=Path(os.environ['FIXTURE_ROOT'])
with (root/'calls').open('a') as f: f.write(' '.join(args)+'\\n')
old='sha256:'+'1'*64; new='sha256:'+'2'*64; snapshot='sha256:'+'3'*64
state=(root/'state').read_text() if (root/'state').exists() else 'old'
if args[:2]==['ps','-aq']: print('nodemail')
elif args[:3]==['image','ls','--format']: print('')
elif args[0]=='info': print('x86_64')
elif args[:2]==['image','inspect']:
    if '--format' in args: print(snapshot if args[2].startswith('nodemail:rollback-') else new)
    else: print(json.dumps([{'Config':{'Env':['PATH=/usr/local/bin:/usr/bin','NODE_ENV=production','MYSQL_PASSWORD=','GUEST_SESSION_SECRET=']}}]))
elif args[0]=='inspect':
    fmt=args[-1]
    if '--format' not in args: print(json.dumps([{'Image':new if state=='new' else old,'Config':{'Env':['PATH=/usr/local/bin:/usr/bin','NODE_ENV=production','MYSQL_PASSWORD=synthetic-secret','GUEST_SESSION_SECRET=synthetic-session'], 'Labels':{'com.docker.compose.project.config_files':str(root/'docker-compose.yml')}}}]))
    elif 'project' in fmt: print('existingproject')
    elif 'Health' in fmt: print('unhealthy' if state=='new' and os.environ['FIXTURE_MODE']=='unhealthy' else 'healthy')
    elif 'Running' in fmt: print('false' if state=='new' and os.environ['FIXTURE_MODE']=='stopped' else 'true')
    elif 'Restarting' in fmt: print('false')
    else: print(new if state=='new' else snapshot if state=='snapshot' else old)
elif args[0]=='commit':
    if os.environ['FIXTURE_MODE']=='snapshot-failure': sys.exit(1)
    print('sha256:'+'4'*64) # CLI digest differs from inspected snapshot identity
elif args[0]=='compose':
    if 'config' in args:
        print(json.dumps({'services':{'nodemail':{'environment':{'MYSQL_PASSWORD':'synthetic-secret','GUEST_SESSION_SECRET':'synthetic-session'}}}})); sys.exit(0)
    files=[args[i+1] for i,a in enumerate(args) if a=='-f']; candidate=files[-1].endswith('candidate.yml')
    (root/'state').write_text('new' if candidate else 'snapshot')
    if candidate and os.environ['FIXTURE_MODE']=='up-failure': sys.exit(1)
elif args[0]=='exec' and state=='new' and os.environ['FIXTURE_MODE']=='service-failure': sys.exit(1)
elif args[0]=='exec' and 'activateAuditRetention' in ' '.join(args) and os.environ['FIXTURE_MODE']=='activation-failure': sys.exit(1)
''')
            docker.chmod(0o755)
            # The preflight has its own tests; bypass it for daemon transaction simulation.
            for name, body in [('python3', '#!/bin/sh\ncase \"$1\" in *deploy_preflight.py) exit 0 ;; *) exec /usr/bin/python3 \"$@\" ;; esac\n'), ('sleep', '#!/bin/sh\nexit 0\n')]:
                p = binaries / name
                p.write_text(body)
                p.chmod(0o755)
            # Fake docker invokes system Python directly so the preflight stub cannot intercept it.
            docker.write_text(docker.read_text().replace('#!/usr/bin/env python3', '#!/usr/bin/python3'))
            import os
            env = {**os.environ, 'PATH': str(binaries) + ':' + os.environ['PATH'],
                   'FIXTURE_ROOT': str(root), 'FIXTURE_MODE': mode}
            result = subprocess.run(['bash', str(script), sha], env=env, capture_output=True, text=True)
            self.assertEqual((root / '.env').read_text(), 'LOCAL_FIXTURE=untouched\n')
            self.assertEqual((root / 'docker-compose.yml').read_text(), 'existing compose fixture\n')
            self.assertEqual((root / 'data/mail.txt').read_text(), 'preserve mail\n')
            calls = (root / 'calls').read_text()
            self.assertNotIn('down', calls)
            self.assertNotIn('prune', calls)
            for call in calls.splitlines():
                if call.startswith('compose ') and ' config ' not in call:
                    self.assertIn('--no-deps --no-build --pull never', call)
                    self.assertTrue(call.endswith(' nodemail'))
            active_path = root / '.deploy/active.yml'
            active = active_path.read_text() if active_path.exists() else ''
            if active: self.assertNotIn('db:init', active.split('command:')[1])
            self.assertIn('commit --pause=true --change ENV ', calls)
            self.assertIn('ENV MYSQL_PASSWORD=', calls)
            self.assertNotIn('synthetic-secret', calls)
            self.assertNotIn('synthetic-session', calls)
            if mode == 'snapshot-failure': self.assertNotIn(' up ', calls)
            if mode in ('snapshot-failure','up-failure','unhealthy','stopped','service-failure'): self.assertNotIn('activateAuditRetention', calls)
            return result, active

    def test_retention_activation_failure_preserves_success(self):
        result, active = self.run_deploy('activation-failure')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('retention remains disabled', result.stdout)
        self.assertNotIn('restoring previous image', result.stderr)
        self.assertIn('image: nodemail:' + 'a' * 40, active)

    def test_cleanup_failure_warns_but_keeps_success(self):
        result, active = self.run_deploy('cleanup-failure')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('cleanup failed; deployment remains successful', result.stdout)
        self.assertNotIn('restoring previous image', result.stderr)
        self.assertIn('/opt filesystem before', result.stdout)
        self.assertIn('/opt filesystem after', result.stdout)

    def test_snapshot_failure_does_not_replace_live_container(self):
        result, active = self.run_deploy('snapshot-failure')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(active, '')

    def test_success_persists_candidate(self):
        result, active = self.run_deploy('healthy')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('image: nodemail:' + 'a' * 40, active)

    def test_rollback_preserves_previous_environment_overlay(self):
        result, active = self.run_deploy('service-failure', previous_overlay=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('PREVIOUS_FIXTURE: preserve', active)
        self.assertIn('image: nodemail:rollback-', active)

    def test_unhealthy_candidate_rolls_back_and_reports_failure(self):
        result, active = self.run_deploy('unhealthy')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Rollback healthy', result.stderr)
        self.assertIn('image: nodemail:rollback-', active)

    def test_partial_compose_failure_rolls_back(self):
        result, active = self.run_deploy('up-failure')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Rollback healthy', result.stderr)
        self.assertIn('image: nodemail:rollback-', active)

    def test_stopped_candidate_with_stale_healthy_status_rolls_back(self):
        result, active = self.run_deploy('stopped')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Rollback healthy', result.stderr)
        self.assertIn('image: nodemail:rollback-', active)

    def test_fresh_website_or_smtp_failure_rolls_back_after_docker_healthy(self):
        result, active = self.run_deploy('service-failure')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Rollback healthy', result.stderr)
        self.assertIn('image: nodemail:rollback-', active)


if __name__ == '__main__':
    unittest.main()
