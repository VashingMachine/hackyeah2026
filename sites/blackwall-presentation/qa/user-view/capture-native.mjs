// Capture Pi's unchanged, official session-export conversation pane.
// Usage: node capture-native.mjs /absolute/path/to/hr.html /absolute/path/to/client.html
import {mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from '/Users/dkwiatkowski/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const root=resolve(import.meta.dirname,'../..');
const dest=join(root,'source/dist/assets/user-view');
const files=process.argv.slice(2);
if(files.length!==2) throw new Error('Provide the two verified native Pi HTML exports.');
mkdirSync(dest,{recursive:true});
// Pi's exported error JSON has no break opportunities. Wrap display text only;
// the base64 session-data block and original messages remain byte-for-byte intact.
for(const [i,id] of ['hr','client'].entries()) {
 const raw=readFileSync(files[i],'utf8');
 const displayStyle='<style id="blackwall-export-readability">.error-text, .user-message .markdown-content { overflow-wrap: anywhere; word-break: break-word; } .tool-command { overflow-wrap: anywhere; white-space: pre-wrap; }</style>';
 writeFileSync(join(dest,`${id}-conversation.html`),raw.replace('</head>',displayStyle+'\n</head>'));
}
const browser=await chromium.launch({headless:true});
const captures=[];
try {
 for(const id of ['hr','client']) {
  for(const mobile of [false,true]) {
   const page=await browser.newPage({viewport:{width:mobile?390:656,height:900},deviceScaleFactor:2,reducedMotion:'reduce'});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(`http://127.0.0.1:8790/assets/user-view/${id}-conversation.html`,{waitUntil:'networkidle'});
   await page.locator('#messages .user-message').last().waitFor();
   await page.locator('#messages .error-text').first().waitFor();
   const conversation=page.locator('#messages');
   const text=await conversation.innerText();
   if(!text.includes('SESSION_TERMINATED')) throw new Error(`${id}: expected actual termination error was absent.`);
   if(errors.length) throw new Error(errors.join('\n'));
   const file=`${id}-blocked${mobile?'-mobile':''}.png`;
   const lastUser=page.locator('#messages .user-message').last();
   await lastUser.scrollIntoViewIfNeeded();
   const box=await page.evaluate(()=>{
     const messages=document.querySelector('#messages');
     const users=messages.querySelectorAll('.user-message');
     const user=users[users.length-1].getBoundingClientRect();
     const errors=messages.querySelectorAll('.error-text');
     const error=errors[errors.length-1].getBoundingClientRect();
     const bounds=messages.getBoundingClientRect();
     return {x:bounds.left+scrollX,y:user.top+scrollY,width:bounds.width,height:error.bottom-user.top};
   });
   await page.screenshot({path:join(dest,file),fullPage:true,clip:box});
   captures.push({case:id,kind:mobile?'mobile':'desktop',image:`assets/user-view/${file}`,sourceExport:`assets/user-view/${id}-conversation.html`,sourceSha256:createHash('sha256').update(readFileSync(files[id==='hr'?0:1])).digest('hex'),viewerSha256:createHash('sha256').update(readFileSync(join(dest,`${id}-conversation.html`))).digest('hex'),viewport:{width:mobile?390:656,height:900},deviceScaleFactor:2,capturedElement:'#messages: final user prompt and its gateway error',cssDimensions:box&&{width:box.width,height:box.height},browserErrors:errors,conversationText:text});
   await page.close();
  }
 }
} finally { await browser.close(); }
writeFileSync(join(import.meta.dirname,'capture-check.json'),JSON.stringify({method:'Browser screenshot of the final user prompt and gateway error in Pi’s official HTML export. Display-only CSS wraps long error JSON and paths; session data and messages are unchanged. Screenshots are not edited.',captures},null,2)+'\n');
console.log(JSON.stringify(captures.map(({case:id,kind,cssDimensions})=>({id,kind,cssDimensions})),null,2));
