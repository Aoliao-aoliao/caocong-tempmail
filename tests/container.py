"""Real candidate-image checks; only a loopback disposable nodemail_ci is accepted."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import uuid


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r"nodemail-distribution-ci:[A-Za-z0-9_.-]{1,128}", sys.argv[1]):
        raise RuntimeError("Pass a dedicated nodemail-distribution-ci image tag.")
    if os.environ.get("NODEMAIL_ISOLATED_TESTS") != "1" or os.environ.get("MYSQL_HOST") != "127.0.0.1" or os.environ.get("MYSQL_DATABASE") != "nodemail_ci":
        raise RuntimeError("Docker distribution checks require isolated loopback nodemail_ci.")
    if len(os.environ.get("GUEST_SESSION_SECRET", "").encode()) < 32 or not os.environ.get("MYSQL_PASSWORD"):
        raise RuntimeError("CI must supply the disposable database password and installation secret.")
    image = sys.argv[1]
    marker = "distribution_docker_" + uuid.uuid4().hex
    name = "nodemail-distribution-test-" + uuid.uuid4().hex[:12]
    upgraded = "nodemail-distribution-ci:upgrade-" + uuid.uuid4().hex[:12]
    env = dict(os.environ)
    env.update({"NODE_ENV": "production", "NODEMAIL_SITE_ORIGIN": "https://mail.installer.example", "NODEMAIL_PUBLIC_ORIGIN": "https://mail.installer.example", "NODEMAIL_GMPAY_ORIGIN": "", "HOST": "127.0.0.1", "PORT": "14321", "SMTP_HOST": "127.0.0.1", "SMTP_PORT": "12525", "SMTP_NAME": "mx.installer.example", "MAIL_ATTACHMENT_DIR": "/app/data/mail-attachments", "RELAY_POLL_INTERVAL_MS": "3600000", "DOMAIN_DNS_CHECK_INTERVAL_MS": "3600000", "MAIL_CLEANUP_INTERVAL_MS": "3600000"})
    identity = uuid.uuid4().hex
    env.update({"TEST_LOGIN_EMAIL": identity + "@example.invalid", "TEST_LOGIN_PASSWORD": secrets.token_urlsafe(36), "TEST_LOGIN_PUBLIC_ID": "U-DIST-" + identity, "TEST_LOGIN_IP": "2001:db8:" + ":".join(identity[n:n + 4] for n in range(0, 24, 4))})
    keys = ["NODEMAIL_ISOLATED_TESTS", "MYSQL_HOST", "MYSQL_PORT", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_CONNECTION_LIMIT", "GUEST_SESSION_SECRET", "NODE_ENV", "NODEMAIL_SITE_ORIGIN", "NODEMAIL_PUBLIC_ORIGIN", "NODEMAIL_GMPAY_ORIGIN", "HOST", "PORT", "SMTP_HOST", "SMTP_PORT", "SMTP_NAME", "MAIL_ATTACHMENT_DIR", "RELAY_POLL_INTERVAL_MS", "DOMAIN_DNS_CHECK_INTERVAL_MS", "MAIL_CLEANUP_INTERVAL_MS"]
    keys.extend(["TEST_LOGIN_EMAIL", "TEST_LOGIN_PASSWORD", "TEST_LOGIN_PUBLIC_ID", "TEST_LOGIN_IP"])
    base = ["--network", "host"]
    for key in keys:
        if key in env:
            base.extend(["--env", key])

    def docker(*args, check=True, timeout=90, stdin=None):
        result = subprocess.run(["docker", *args], input=stdin, text=True, capture_output=True, env=env, timeout=timeout)
        if check and result.returncode:
            # Only this disposable test is involved. Redact its secrets before a bounded diagnostic.
            diagnostic = result.stderr[-3000:]
            for key in ["MYSQL_PASSWORD", "GUEST_SESSION_SECRET", "TEST_LOGIN_PASSWORD", "TEST_LOGIN_EMAIL", "TEST_LOGIN_PUBLIC_ID"]:
                if env.get(key):
                    diagnostic = diagnostic.replace(env[key], "<redacted>")
            raise RuntimeError("Dedicated Docker distribution operation failed (exit %s): %s" % (result.returncode, diagnostic))
        return result

    def node_once(source, selected=image):
        result = docker("run", "--rm", *base, selected, "node", "--input-type=module", "-e", source)
        return result.stdout.strip()

    def request(path, host="mail.installer.example", forwarded=None, proto="https", method="GET", payload=None, cookie=None, origin=None):
        connection = http.client.HTTPConnection("127.0.0.1", 14321, timeout=4)
        try:
            headers = {"Host": host, "X-Forwarded-Proto": proto}
            if forwarded is not None:
                headers["X-Forwarded-Host"] = forwarded
            if origin is not None:
                headers["Origin"] = origin
            if cookie is not None:
                headers["Cookie"] = cookie
            if payload is not None:
                headers.update({"Content-Type": "application/json", "X-Real-IP": env["TEST_LOGIN_IP"]})
            connection.request(method, path, body=json.dumps(payload) if payload is not None else None, headers=headers)
            response = connection.getresponse()
            body = response.read(1024 * 1024).decode("utf-8", errors="replace")
            return response.status, body, response.getheaders()
        finally:
            connection.close()

    def wait_ready():
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try:
                code, body, _headers = request("/api/health", host="127.0.0.1:14321", proto="http")
                if code == 200 and json.loads(body).get("ok") is True:
                    return
            except (OSError, ValueError, http.client.HTTPException):
                pass
            time.sleep(0.5)
        raise RuntimeError("Candidate did not become healthy within 45 seconds.")

    def expect_status(response, expected, label):
        assert response[0] == expected, "%s: expected HTTP %s, got %s." % (label, expected, response[0])
        return response

    def assert_running_routes():
        status, body, _headers = expect_status(request("/user/login.cgi"), 200, "Installer domain login page")
        assert "NodeMail" in body, "Installer domain login page must render."
        assert "mail.example.invalid" not in body, "UI must not send visitors to the author's installation."
        # This API validates request origin before looking up a session, even for GET.
        expect_status(request("/api/admin/list?section=users"), 403, "Admin API without request origin")
        expect_status(request("/api/admin/list?section=users", origin=env["NODEMAIL_SITE_ORIGIN"]), 401, "Same-origin anonymous admin API")
        expect_status(request("/user/login.cgi", host="untrusted.example"), 421, "Unknown Host")
        expect_status(request("/user/login.cgi", forwarded="untrusted.example"), 421, "Unknown forwarded host")
        expect_status(request("/user/login.cgi", host="127.0.0.1:14321", proto="http"), 421, "Loopback health-only exception")
        with socket.create_connection(("127.0.0.1", 12525), timeout=4) as smtp:
            assert smtp.recv(1024).startswith(b"220"), "SMTP greeting required; no message is sent."

    def assert_login():
        payload = {"email": env["TEST_LOGIN_EMAIL"], "password": "intentionally-invalid-password"}
        expect_status(request("/api/auth/login", method="POST", payload=payload, origin="https://untrusted.example"), 403, "Foreign login origin")
        expect_status(request("/api/auth/login", method="POST", payload=payload, origin=env["NODEMAIL_SITE_ORIGIN"]), 401, "Same-origin invalid credentials")
        payload["password"] = env["TEST_LOGIN_PASSWORD"]
        status, body, headers = expect_status(request("/api/auth/login", method="POST", payload=payload, origin=env["NODEMAIL_SITE_ORIGIN"]), 200, "Synthetic administrator login")
        assert json.loads(body).get("ok") is True, "Synthetic administrator must log in through the real API."
        cookies = [value for key, value in headers if key.lower() == "set-cookie"]
        session = next((value for value in cookies if "; httponly" in value.lower()), "")
        assert session and "; secure" in session.lower() and "; samesite=lax" in session.lower(), "HTTPS session must have Secure, HttpOnly and SameSite flags."
        cookie = session.split(";", 1)[0]
        # /auth/me reads the session cookie directly; it does not use requireApiUser.
        status, body, _headers = expect_status(request("/api/auth/me", cookie=cookie), 200, "Authenticated session lookup")
        assert json.loads(body).get("user", {}).get("email") == env["TEST_LOGIN_EMAIL"]
        return cookie

    marker_exists = False
    login_fixture_exists = False
    created_container = False
    created_tag = False
    # A separate container cleans UID-1000-owned children before the host removes
    # this directory. Do not let a secondary host permission error mask a failed check.
    with tempfile.TemporaryDirectory(prefix="nodemail-distribution-attachments-", ignore_cleanup_errors=True) as temporary:
        os.chmod(temporary, 0o777)  # Synthetic dedicated attachment path, writable by container UID 1000.
        mount = ["--mount", "type=bind,source=%s,target=/app/data/mail-attachments" % temporary]
        attachment = Path(temporary, marker + ".txt")
        attachment.write_bytes(b"synthetic distribution upgrade preservation fixture")
        Path(temporary, ".distribution-test-owner").write_text(marker, encoding="utf-8")
        attachment_hash = hashlib.sha256(attachment.read_bytes()).hexdigest()
        try:
            # Installation suite has prepared this fresh database; no init/reset occurs here.
            docker("run", "--rm", *base, image, "node", "distribution/runtime/setup.mjs", "check")
            node_once("import assert from 'node:assert/strict';import {openDatabase,closeDatabasePool} from './server/db/database.mjs';const c=await openDatabase();try{for(const t of ['relay_accounts','domains']){const [[r]]=await c.query('SELECT COUNT(*) AS n FROM '+t);assert.equal(Number(r.n),0,'No real relay or domain may be configured for this test');}}finally{c.release();await closeDatabasePool();}")
            node_once("import assert from 'node:assert/strict';import {existsSync,readdirSync,readFileSync,lstatSync} from 'node:fs';for(const p of ['src','.git','.env','docs','tests'])assert(!existsSync('/app/'+p),'Excluded source/private path present: '+p);function walk(p){for(const n of readdirSync(p)){const f=p+'/'+n;if(lstatSync(f).isDirectory())walk(f);else assert(!n.endsWith('.map'),'Application source map present');}}walk('/app/server');walk('/app/dist/server');assert(readFileSync('/app/server/relay/poller.mjs','utf8').includes('recoverJunkMail'),'Backend source module missing');")
            print("PASS: image boundary and explicit installation check")
            node_once("""import assert from 'node:assert/strict';
import {createReleaseChecker,STABLE_FEED_URL} from './server/updates/checker.mjs';
let requests=0;
const check=createReleaseChecker({fetcher:async(url,options)=>{
  requests++;assert.equal(url,STABLE_FEED_URL);assert.equal(new URL(url).search,'');
  assert.equal(options.body,undefined);assert.equal(options.method,undefined);assert.equal(options.redirect,'error');
  const headers=new Headers(options.headers);assert.equal(headers.has('authorization'),false);assert.equal(headers.has('cookie'),false);
  assert.deepEqual([...headers.keys()].sort(),['accept','cache-control','user-agent']);
  const sent=JSON.stringify({url,headers:[...headers]});
  for(const value of [process.env.GUEST_SESSION_SECRET,process.env.MYSQL_PASSWORD,process.env.TEST_LOGIN_EMAIL])assert(!sent.includes(value),'Update request leaked installation/account data');
  return new Response(JSON.stringify({schema:1,product:'NodeMail',channel:'stable',version:'0.0.2',publishedAt:'2026-10-08T13:00:00.000Z',notes:'Synthetic update test'}),{headers:{'content-type':'application/json'}});
}});
const result=await check({force:true});assert.equal(requests,1);assert.equal(result.currentVersion,'0.0.1');assert.equal(result.status,'available');assert.equal(result.latest.version,'0.0.2');
""")
            print("PASS: actual image detects a mocked official update without sending secrets or account data")
            node_once("""import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {openDatabase,closeDatabasePool} from './server/db/database.mjs';import {hashPassword} from './server/auth/service.mjs';
const c=await openDatabase();try{
  for(const [action,value] of [['LOGIN_ACCOUNT',process.env.TEST_LOGIN_EMAIL],['LOGIN_IP',process.env.TEST_LOGIN_IP]]){
    const [[r]]=await c.execute('SELECT COUNT(*) AS n FROM auth_rate_limits WHERE action=? AND key_hash=?',[action,createHash('sha256').update(value).digest('hex')]);assert.equal(Number(r.n),0);
  }
  await c.execute("INSERT INTO users(public_id,email,password_hash,role,status,points_balance,locale) VALUES (?,?,?,'SUPER_ADMIN','ACTIVE',0,'zh-CN')",[process.env.TEST_LOGIN_PUBLIC_ID,process.env.TEST_LOGIN_EMAIL,await hashPassword(process.env.TEST_LOGIN_PASSWORD)]);
}finally{c.release();await closeDatabasePool();}
""")
            login_fixture_exists = True
            # Empty secret must fail before any listeners start. Environment values never enter arguments.
            previous = env.pop("GUEST_SESSION_SECRET")
            try:
                failed = docker("run", "--rm", *base, image, check=False, timeout=30)
                assert failed.returncode != 0, "Missing master secret must reject startup."
            finally:
                env["GUEST_SESSION_SECRET"] = previous
            print("PASS: missing master secret refuses startup")
            docker("run", "--detach", "--name", name, *base, *mount, image)
            created_container = True
            wait_ready(); assert_running_routes()
            session_cookie = assert_login()
            docker("exec", name, "node", "distribution/runtime/healthcheck.mjs")
            source = "import {openDatabase,closeDatabasePool} from './server/db/database.mjs';const c=await openDatabase();try{await c.execute(\"INSERT INTO system_settings(`key`,value,value_type) VALUES (?,?,'string')\",[" + json.dumps(marker) + ", 'synthetic retained value']);}finally{c.release();await closeDatabasePool();}"
            docker("exec", name, "node", "--input-type=module", "-e", source)
            marker_exists = True
            print("PASS: real login POST, secure cookie, health, admin authorization, host validation and SMTP greeting")
            docker("stop", "--time", "15", name); docker("rm", name); created_container = False
            docker("tag", image, upgraded); created_tag = True
            docker("run", "--rm", *base, upgraded, "node", "distribution/runtime/setup.mjs", "check")
            docker("run", "--detach", "--name", name, *base, *mount, upgraded); created_container = True
            wait_ready(); assert_running_routes()
            status, body, _headers = expect_status(request("/api/auth/me", cookie=session_cookie), 200, "Session after image replacement")
            assert json.loads(body).get("user", {}).get("email") == env["TEST_LOGIN_EMAIL"], "Existing session must survive same-secret image replacement."
            value = node_once("import {openDatabase,closeDatabasePool} from './server/db/database.mjs';const c=await openDatabase();try{const [[r]]=await c.execute('SELECT value FROM system_settings WHERE `key`=?',[" + json.dumps(marker) + "]);console.log(JSON.stringify(r?.value));}finally{c.release();await closeDatabasePool();}", selected=upgraded)
            assert json.loads(value) == "synthetic retained value"
            assert hashlib.sha256(attachment.read_bytes()).hexdigest() == attachment_hash
            print("PASS: same-schema image replacement preserves user, session, database marker and attachment")
        finally:
            original_error = sys.exc_info()[1]
            cleanup_errors = []

            def cleanup(action):
                try:
                    action()
                except Exception:
                    # Attempt every owned resource even if one cleanup operation fails.
                    cleanup_errors.append(True)

            if created_container:
                cleanup(lambda: docker("stop", "--time", "15", name))
                cleanup(lambda: docker("rm", name))
            if marker_exists:
                cleanup(lambda: node_once("import {openDatabase,closeDatabasePool} from './server/db/database.mjs';const c=await openDatabase();try{await c.execute('DELETE FROM system_settings WHERE `key`=?',[" + json.dumps(marker) + "]);}finally{c.release();await closeDatabasePool();}"))
            if login_fixture_exists:
                cleanup(lambda: node_once("""import {createHash} from 'node:crypto';import {openDatabase,closeDatabasePool} from './server/db/database.mjs';const c=await openDatabase();try{
await c.execute('DELETE FROM users WHERE email=? AND public_id=?',[process.env.TEST_LOGIN_EMAIL,process.env.TEST_LOGIN_PUBLIC_ID]);
for(const [action,value] of [['LOGIN_ACCOUNT',process.env.TEST_LOGIN_EMAIL],['LOGIN_IP',process.env.TEST_LOGIN_IP]])await c.execute('DELETE FROM auth_rate_limits WHERE action=? AND key_hash=?',[action,createHash('sha256').update(value).digest('hex')]);
}finally{c.release();await closeDatabasePool();}"""))
            if created_tag:
                cleanup(lambda: docker("image", "rm", upgraded))
            # Only the generated bind mount is present. No database credentials,
            # network, shared volume or external path is available to this helper.
            cleanup_source = """import assert from 'node:assert/strict';
import {lstat,readFile,realpath,readdir,rm,unlink} from 'node:fs/promises';import {join} from 'node:path';
const root='/app/data/mail-attachments',owner='.distribution-test-owner';
assert.equal(await realpath(root),root);assert((await lstat(root)).isDirectory());
assert.equal(await readFile(join(root,owner),'utf8'),""" + json.dumps(marker) + """);
for(const name of await readdir(root))if(name!==owner)await rm(join(root,name),{recursive:true,force:true});
await unlink(join(root,owner));
"""
            cleanup(lambda: docker("run", "--rm", "--network", "none", "--user", "0:0", *mount, image, "node", "--input-type=module", "-e", cleanup_source))
            if cleanup_errors:
                message = "One or more dedicated test resources could not be cleaned; no shared database or volume reset was attempted."
                print("WARNING: " + message, file=sys.stderr)
                if original_error is not None:
                    original_error.add_note(message)
                else:
                    raise RuntimeError(message)
    print("PASS: dedicated test resources cleaned; database/volumes were not reset")


if __name__ == "__main__":
    main()
