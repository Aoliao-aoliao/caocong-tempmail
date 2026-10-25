import test from 'node:test';
import assert from 'node:assert/strict';
import {extractVerificationCode as extract, withVerificationCode, CODE_SCAN_LIMIT} from '../server/mail/verification-code.mjs';

test('extracts contextual numeric and mixed codes from subjects and text',()=>{
 for(const [subject,expected] of [
  ['您的验证码：001234，五分钟内有效','001234'],['驗證碼為 8074','8074'],
  ['Your verification code is 123456','123456'],['123456 is your verification code','123456'],
  ['Security code: A1B2C3','A1B2C3'],['OTP: 123-456','123456'],['One-time password: 1234 5678','12345678'],
 ]) assert.equal(extract({subject}),expected,subject);
 assert.equal(extract({subject:'Your verification code',text:'001234'}),'001234');
 assert.equal(extract({subject:'Verify your email',html:'<div>001234</div>'}),'001234');
 assert.equal(extract({subject:'Confirm account',text:'Your login code is 001122.'}),'001122');
 assert.equal(extract({subject:'Verification code 123456',text:'Old verification code 654321'}),'123456');
});
test('HTML-only codes, inline digit spans and numeric entities, without script/style/URL attributes',()=>{
 assert.equal(extract({html:'<style>.code{color:#123456}</style><p>Verification code</p><div><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span></div>'}),'123456');
 assert.equal(extract({html:'<p>Verification code</p><table><tr><td>0</td> <td>0</td> <td>1</td> <td>2</td> <td>3</td> <td>4</td></tr></table>'}),'001234');
 assert.equal(extract({text:'Your code is 12\u200b3456'}),'123456');
 assert.equal(extract({html:'<p>验证码</p><b>&#48;&#x30;&#49;&#50;&#51;&#52;</b>'}),'001234');
 assert.equal(extract({html:'<script>"verification code 999999"</script><a href="https://x.test/code/123456">Welcome</a>'}),null);
 assert.equal(extract({text:'Read the HTML',html:'<p>Your code is 765432</p>'}),'765432');
});
test('avoids unrelated numbers, dates, telephone, order IDs, ambiguity and expensive unbounded input',()=>{
 for(const text of ['Order 123456, total $49.00','Contact +1-202-555-0123','Verification date 2026-10-25',
  'Your code arrives on 2026-10-25','Your code expires in 1440 minutes','Order code: 123456',
  'Your code: 123456 or 654321','Verification code https://example.test/123456',
  'Verification code: 1234567890123456']) assert.equal(extract({text}),null,text);
 assert.equal(extract({text:'x'.repeat(CODE_SCAN_LIMIT)+' verification code 123456'}),null);
 assert.equal(extract({html:'<'.repeat(CODE_SCAN_LIMIT)}),null);
});
test('list projection exposes only the code, never internal body snippets',()=>{
 const row=withVerificationCode({id:'synthetic',subject:'Welcome',_code_text:'Your code is 123456. private body',_code_html:'secret body'});
 assert.deepEqual(row,{id:'synthetic',subject:'Welcome',verificationCode:'123456'});
 assert.equal(JSON.stringify(row).includes('private body'),false);
});
