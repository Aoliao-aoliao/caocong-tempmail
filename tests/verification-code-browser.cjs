const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
assert.equal(process.env.NODEMAIL_ISOLATED_TESTS,'1');assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_DATABASE,'nodemail_ci');
const work=process.env.NODEMAIL_BROWSER_WORKDIR;assert.ok(work);
const data=JSON.parse(fs.readFileSync(work+'/browser-session.json')),origin='https://mail.installer.example';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.NODEMAIL_CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});const reports=[],errors=[];
 try{
  for(const width of [1440,390])for(const locale of ['zh-CN','zh-TW','en-US'])for(const member of [true,false]){
   const context=await browser.newContext({viewport:{width,height:900},userAgent:data.ua,permissions:['clipboard-read','clipboard-write']});
   let closing=false;try{
    await context.addCookies([{name:member?data.sessionCookieName:data.guestCookieName,value:member?data.token:data.guestToken,url:origin},{name:'nodemail_locale',value:locale,url:origin}]);
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',async r=>{const u=new URL(r.request().url());if(u.origin!==origin)return r.abort();try{const response=await r.fetch({url:'http://127.0.0.1:14324'+u.pathname+u.search,headers:{...r.request().headers(),host:u.host,'x-forwarded-proto':'https'},maxRedirects:0});await r.fulfill({response});}catch(error){if(!closing)errors.push(String(error));await r.abort().catch(()=>{});}});
    for(const path of member?['/tools/mail.cgi','/tools/real_mail.cgi','/user/center.cgi','/user/mails.cgi']:['/tools/mail.cgi','/tools/real_mail.cgi']){
     console.log(width,locale,member,path);assert.equal((await page.goto(origin+path)).status(),200,path);await page.waitForFunction(()=>!document.querySelector('astro-island[ssr]'));
     const button=page.locator('.verification-code-copy').first();await button.waitFor();await page.evaluate(()=>document.fonts.ready);assert.equal(await page.locator('.verification-code-value').first().textContent(),'001234');
     let opened=0;const listener=r=>{if(/\/api\/(?:user|guest)\/messages\/(?!list)/.test(r.url()))opened++};page.on('request',listener);
     await button.click();await page.waitForFunction(()=>document.querySelector('.verification-code-copy')?.textContent.includes('✓'));
     assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'001234');assert.equal(opened,0);
     assert.equal(await page.locator('.mc-mail-reader').count(),0);assert.equal(await page.locator('button button').count(),0);assert.ok(await button.isVisible());await button.scrollIntoViewIfNeeded();await page.waitForTimeout(200);
     const layout=await page.evaluate(()=>{const b=document.querySelector('.verification-code-copy').getBoundingClientRect(),v=document.querySelector('.verification-code-value').getBoundingClientRect();return {horizontal:document.documentElement.scrollWidth>innerWidth+1,buttonWidth:b.width,buttonTop:b.top,buttonBottom:b.bottom,beside:b.left>=v.right-1,visible:b.left>=-1&&b.right<=innerWidth+1&&b.top>=-1&&b.bottom<=innerHeight+1};});
     assert.equal(layout.horizontal,false);assert.ok(layout.buttonWidth>=28&&layout.beside&&layout.visible,JSON.stringify(layout));
     assert.equal(await button.getAttribute('aria-label'),locale==='en-US'?'Copied':locale==='zh-TW'?'已複製':'已复制');
     reports.push({path,width,locale,member,...layout,copied:true,opened});page.off('request',listener);
     if(width===390&&locale==='zh-CN')await page.waitForTimeout(300);
     if(width===390&&locale==='zh-CN')await page.screenshot({path:work+`/otp-${member?'member':'guest'}-${path.split('/').pop()}.png`,fullPage:false});
    }
    // A rejected clipboard write/fallback must not claim success or open a message.
    await page.evaluate(()=>{Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{throw new Error('synthetic denied')}});document.execCommand=()=>false});
    const button=page.locator('.verification-code-copy').first();await button.click();await page.waitForFunction(()=>document.querySelector('.verification-code-copy')?.getAttribute('aria-label')?.match(/失败|失敗|failed/));assert.equal(await page.locator('.mc-mail-reader').count(),0);
    // Keyboard use also copies without activating the containing row.
    await page.evaluate(()=>Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async value=>{window.syntheticCopied=value}}));
    await button.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>window.syntheticCopied==='001234');assert.equal(await page.locator('.mc-mail-reader').count(),0);
    const open=page.locator('.mail-code-open,.mc-mail-open').first();await open.click();await page.locator('.mc-mail-reader').waitFor();await page.keyboard.press('Escape');await page.locator('.mc-mail-reader').waitFor({state:'hidden'});
   }finally{closing=true;await context.close()}
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(work+'/browser-results.json',JSON.stringify({pages:reports.length,pageErrors:errors.length,reports},null,2));console.log(JSON.stringify({pages:reports.length,pageErrors:errors.length,result:'passed'}));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
