const loginArea=document.getElementById('loginArea');const userArea=document.getElementById('userArea');const welcome=document.getElementById('welcome');const scratchBtn=document.getElementById('scratchBtn');const prizeName=document.getElementById('prizeName');const prizeDetail=document.getElementById('prizeDetail');const hint=document.getElementById('hint');const canvas=document.getElementById('scratchCanvas');const ctx=canvas.getContext('2d');let drawResult=null, revealed=false, scratching=false;
function paintCover(){const rect=canvas.getBoundingClientRect();const dpr=window.devicePixelRatio||1;canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);const g=ctx.createLinearGradient(0,0,rect.width,rect.height);g.addColorStop(0,'#8c69b4');g.addColorStop(.5,'#c6a6dc');g.addColorStop(1,'#76549d');ctx.fillStyle=g;ctx.fillRect(0,0,rect.width,rect.height);ctx.fillStyle='#fff4ff';ctx.textAlign='center';ctx.font='bold 22px sans-serif';ctx.fillText('✧ SCRATCH HERE ✧',rect.width/2,rect.height/2+7);ctx.font='12px sans-serif';ctx.fillText('刮開你的幸運',rect.width/2,rect.height/2+34)}
function erase(e){if(!scratching||revealed)return;const r=canvas.getBoundingClientRect();const p=e.touches?e.touches[0]:e;const x=p.clientX-r.left,y=p.clientY-r.top;ctx.globalCompositeOperation='destination-out';ctx.beginPath();ctx.arc(x,y,19,0,Math.PI*2);ctx.fill();ctx.globalCompositeOperation='source-over'}
canvas.addEventListener('pointerdown',e=>{if(!drawResult||revealed)return;scratching=true;canvas.setPointerCapture(e.pointerId);erase(e)});canvas.addEventListener('pointermove',erase);canvas.addEventListener('pointerup',()=>{scratching=false});
function reveal(){if(revealed)return;revealed=true;ctx.clearRect(0,0,canvas.width,canvas.height);canvas.style.display='none';hint.textContent='恭喜獲得獎項！記得截圖保存並聯絡踢吶兌獎 ♡'}
async function loadMe(){try{const r=await fetch('/api/me');const d=await r.json();if(!d.loggedIn)return;loginArea.classList.add('hidden');userArea.classList.remove('hidden');welcome.textContent=`歡迎回來，${d.user.username} ♡`;if(d.draw){drawResult={prize_name:d.draw.prize_name};prizeName.textContent=d.draw.prize_name;prizeDetail.textContent='這是你已經抽中的獎項，請截圖保存！';scratchBtn.textContent='查看我的獎項';scratchBtn.disabled=true;hint.textContent='每個 Discord 帳號限抽一次';setTimeout(reveal,250)}else{paintCover();hint.textContent='按下開始抽獎後，刮開卡片查看結果'}}catch(e){console.error(e)}}
scratchBtn.addEventListener('click',async()=>{if(drawResult){reveal();return}scratchBtn.disabled=true;scratchBtn.textContent='幸運抽取中…';try{const r=await fetch('/api/scratch',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const d=await r.json();if(!r.ok)throw new Error(d.error||'抽獎失敗');drawResult=d.prize;prizeName.textContent=d.prize.prize_name;prizeDetail.textContent=d.prize.detail||'請截圖保存並聯絡踢吶兌獎 ♡';scratchBtn.textContent='已抽出獎項';hint.textContent='用手指或滑鼠刮開上方卡片！';if(d.already){scratchBtn.disabled=true;setTimeout(reveal,300)}else{scratchBtn.disabled=true}}catch(e){alert(e.message);scratchBtn.disabled=false;scratchBtn.textContent='重新抽取'}});
window.addEventListener('resize',()=>{if(!drawResult&&!revealed&&canvas.style.display!=='none')paintCover()});paintCover();loadMe();

/* TINA SHOP 活動截止設定 */
const EVENT_END_TIME = new Date('2026-11-21T23:23:00+08:00');

function checkEventEnd() {
  if (Date.now() < EVENT_END_TIME.getTime()) return;

  let notice = document.getElementById('eventEndedNotice');

  if (!notice) {
    notice = document.createElement('p');
    notice.id = 'eventEndedNotice';
    notice.textContent = '活動已結束，感謝參與 TINA SHOP！♡';
    notice.style.cssText =
      'text-align:center;color:#f5b6e8;font-weight:bold;margin:20px;';

    document.querySelector('.hero')?.appendChild(notice);
  }

  if (!drawResult) {
    loginArea.classList.add('hidden');
    scratchBtn.disabled = true;
    scratchBtn.textContent = '活動已結束';
    canvas.style.display = 'none';
    hint.textContent = '活動已結束，感謝參與 TINA SHOP！';

  }
}

checkEventEnd();
setInterval(checkEventEnd, 10000);
