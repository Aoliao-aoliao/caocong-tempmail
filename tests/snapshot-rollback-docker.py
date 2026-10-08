"""Real Docker rollback exercise; synthetic config, no ports, database or mail."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('snapshot', ROOT / 'scripts/snapshot_rollback.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout

def main():
    image = 'nodemail:' + os.environ['GITHUB_SHA']
    project = 'nodemail-ci-snapshot-' + uuid.uuid4().hex[:12]
    tag = 'nodemail:rollback-' + os.environ['GITHUB_SHA'] + '-1-1'
    container = project + '-fixture'
    with tempfile.TemporaryDirectory(prefix=project) as tmp:
        root = Path(tmp)
        base = root / 'compose.json'
        overlay = root / 'active.json'
        rollback = root / 'rollback.json'
        envfile = root / '.env'
        envfile.write_text('SYNTHETIC_SECRET=ci-only-not-a-real-secret\n')
        environment = {'NODE_ENV':'production','HOST':'0.0.0.0','PORT':'4321',
                       'MYSQL_PASSWORD':'${SYNTHETIC_SECRET}', 'GUEST_SESSION_SECRET':'ci-only-session',
                       'EMPTY_FIXTURE':'','UNICODE_FIXTURE':'回滚 fixture'}
        base.write_text(json.dumps({'services':{'nodemail':{
            'image':image,'container_name':container,'environment':environment,
            'entrypoint':['node'],'command':['-e','setInterval(()=>{},1000)'],
            'healthcheck':{'disable':True},'network_mode':'none',
        }}},ensure_ascii=False))
        overlay.write_text(json.dumps({'services':{'nodemail':{'environment':{'GMPAY_SECRET_KEY':'ci-only-overlay'}}}}))
        args = ['--project-directory',str(root),'--env-file',str(envfile),'-p',project,'-f',str(base)]
        try:
            run('docker','compose',*args,'-f',str(overlay),'up','-d','--no-build','--pull','never')
            run('docker','exec',container,'node','-e',"require('fs').writeFileSync('/tmp/rollback-fixture','preserved-layer')")
            original = dict(x.split('=',1) for x in json.loads(run('docker','inspect',container))[0]['Config']['Env'])
            helper.snapshot(container,tag,[*args,'-f',str(overlay)])
            saved = dict(x.split('=',1) for x in json.loads(run('docker','image','inspect',tag))[0]['Config']['Env'])
            assert all(not v for k,v in saved.items() if k not in {'PATH','NODE_ENV'})
            rollback.write_text(json.dumps({'services':{'nodemail':{'image':tag,'environment':{'GMPAY_SECRET_KEY':'ci-only-overlay'}}}}))
            run('docker','compose',*args,'-f',str(rollback),'up','-d','--no-deps','--no-build','--pull','never','--force-recreate','nodemail')
            restored = json.loads(run('docker','exec',container,'node','-e','console.log(JSON.stringify(process.env))'))
            for key in [*environment,'GMPAY_SECRET_KEY']:
                assert restored[key] == original[key], 'Rollback environment mismatch: ' + key
            assert run('docker','exec',container,'node','-e',"console.log(require('fs').readFileSync('/tmp/rollback-fixture','utf8'))").strip() == 'preserved-layer'
            print('Real Docker rollback passed: snapshot Env scrubbed; Compose settings and writable layer restored')
        finally:
            # Only this uniquely named fixture container/image/network; no volumes.
            subprocess.run(['docker','rm','-f',container],capture_output=True)
            subprocess.run(['docker','image','rm',tag],capture_output=True)

if __name__ == '__main__':
    main()
