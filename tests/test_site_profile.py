import importlib.util
import json
import unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('profile',Path(__file__).resolve().parents[1]/'scripts/site_profile.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ProfileTests(unittest.TestCase):
 def test_preserves_gateway_substitutions_and_escapes_compose_interpolation(self):
  p={'NODEMAIL_SITE_ORIGIN':'https://mail.example.test','NODEMAIL_PUBLIC_ORIGIN':'https://public.example.test','NODEMAIL_CONTACT_EMAIL':'a$b@example.test','NODEMAIL_EMAIL_DOMAIN':'example.test','NODEMAIL_GMPAY_ORIGIN':'https://pay.example.test'}
  text=m.render(p,'    environment:\n      GMPAY_SECRET_KEY: ${GMPAY_SECRET_KEY:-}\n')
  self.assertIn('GMPAY_SECRET_KEY: ${GMPAY_SECRET_KEY:-}',text);self.assertIn('a$$b@example.test',text)
  p['MYSQL_PASSWORD']='must-not-be-copied';self.assertRaises(ValueError,m.render,p,'')
 def test_rejects_unsafe_origins(self):
  p={k:'x' for k in m.KEYS};self.assertRaises(ValueError,m.render,p,'')
