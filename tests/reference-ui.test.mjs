import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

async function moduleFromSource(file,globals={}) {
  const source=await readFile(new URL(file,import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const exports={};runInNewContext(compiled,{exports,...globals});return exports;
}

test('clipboard confirms writes, falls back on denial and restores focus without false success',async()=>{
  let removed=0,restored=0,selected=0,writes=[];
  const document={activeElement:{focus(){restored++;}},getSelection:()=>null,body:{append(){}},createElement:()=>({style:{},select(){selected++;},remove(){removed++;}}),execCommand:()=>false};
  const navigator={clipboard:{async writeText(value){writes.push(value);}}};
  const {copyText}=await moduleFromSource('../src/lib/clipboard.ts',{navigator,document});
  assert.equal(await copyText('mail@example.test'),true);assert.deepEqual(writes,['mail@example.test']);assert.equal(removed,0);
  navigator.clipboard.writeText=async()=>{throw new Error('denied');};
  assert.equal(await copyText('mail@example.test'),false);assert.equal(selected,1);assert.equal(removed,1);assert.equal(restored,1);
  document.execCommand=()=>true;assert.equal(await copyText('mail@example.test'),true);
  document.execCommand=()=>{throw new Error('unsupported');};assert.equal(await copyText('mail@example.test'),false);
  assert.equal(removed,3);assert.equal(restored,3);assert.equal(await copyText(''),false);
});

test('locale uses explicit supported choices, preserves unknown content and formats placeholders',async()=>{
  const catalog=JSON.parse(await readFile(new URL('../src/lib/ui-translations.json',import.meta.url),'utf8'));
  const {requestLocale,translate}=await moduleFromSource('../src/lib/locale.ts',{require:()=>catalog});
  const context=(query,cookie)=>({url:new URL(`https://example.test/user/login.cgi${query}`),cookies:{get:()=>cookie?{value:cookie}:undefined}});
  assert.equal(requestLocale(context('?lang=en-US','zh-TW')),'en-US');
  assert.equal(requestLocale(context('','zh-TW')),'zh-TW');
  assert.equal(requestLocale(context('?lang=invalid','en-US')),'zh-CN');
  assert.equal(translate('选择州','en-US'),'Choose a state');
  assert.equal(translate('已复制','zh-TW'),'已複製');
  assert.equal(translate('原始邮件 <script>','en-US'),'原始邮件 <script>');
  assert.match(translate('{0} 积分','en-US',21),/21/);
  for(const [key,row] of Object.entries(catalog)){
    assert.ok(row.en&&row.tw,`Missing translation: ${key}`);
    const placeholders=value=>(value.match(/\{\d+\}/g)||[]).sort();
    assert.deepEqual(placeholders(row.en),placeholders(key),key);
    assert.deepEqual(placeholders(row.tw),placeholders(key),key);
  }
});
