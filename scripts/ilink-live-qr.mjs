/** Print a live QR URL continuously, replacing each one as it dies. */
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const BASE='https://ilinkai.weixin.qq.com/';
const B={channel_version:'2.4.6',bot_agent:'DeepSeekHarness/w2m'};
const uin=()=>Buffer.from(String(randomBytes(4).readUInt32BE(0)),'utf8').toString('base64');
const H=()=>({'content-type':'application/json','iLink-App-Id':'bot','iLink-App-ClientVersion':String((2<<16)|(4<<8)|6),'X-WECHAT-UIN':uin(),AuthorizationType:'ilink_bot_token'});
const P=async(ep,b)=>(await fetch(new URL(ep,BASE).toString(),{method:'POST',headers:H(),body:JSON.stringify(b),signal:AbortSignal.timeout(25000)})).json();
const t=()=>new Date().toISOString().slice(11,19);
const mint=async()=>{const q=await P('ilink/bot/get_bot_qrcode?bot_type=3',{base_info:B});return q;};
let q=await mint();
console.log(`[${t()}] LIVE_URL=${q.qrcode_img_content}`);
let last='';
const deadline=Date.now()+25*60*1000;
for(;;){
  if(Date.now()>deadline){console.log(`[${t()}] TIMEOUT`);process.exit(3);}
  await new Promise(r=>setTimeout(r,2000));
  let s; try{ s=await P(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(q.qrcode)}`,{base_info:B}); }catch{continue;}
  const st=String(s?.status??s?.state??'');
  if(st!==last){ console.log(`[${t()}] state=${st}`); last=st; }
  if(st==='expired'){ q=await mint(); last=''; console.log(`[${t()}] LIVE_URL=${q.qrcode_img_content}`); continue; }
  const tok=s?.bot_token??s?.token??null;
  if(tok){
    writeFileSync('dist/ilink/ilink-login.json',JSON.stringify({bot_token:tok,baseurl:s.baseurl??BASE,ilink_bot_id:s.ilink_bot_id??null,ilink_user_id:s.ilink_user_id??null,obtained_at:new Date().toISOString()},null,2),{mode:0o600});
    console.log(`[${t()}] SCANNED token=${tok.length}chars bot_id=${s.ilink_bot_id} user_id=${s.ilink_user_id}`);
    process.exit(0);
  }
}
