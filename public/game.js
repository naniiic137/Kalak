const socket = io();

const AVATARS = ['😎','🤖','👾','🎮','🕹️','🦊','🐱','🐶','🦁','🐸','🐵','🦄','🐲','🎃','👻','🤠','🥷','🧙','🦸','🧛','🐼','🦋','🐙','🦖','🎭','🤡','🐺','🦅','🐝','🎯'];

const CAT = {
  ar:{general:'عام 🌍',geography:'جغرافيا 🗺️',history:'تاريخ 📜',science:'علوم 🔬',literature:'أدب 📚',sports:'رياضة ⚽',entertainment:'ترفيه 🎬',technology:'تقنية 💻',food:'طعام 🍕',islam:'إسلام 🕌',arabic:'عربي 🏜️',animals:'حيوانات 🐾',flags:'أعلام 🏳️'},
  en:{general:'General 🌍',geography:'Geography 🗺️',history:'History 📜',science:'Science 🔬',literature:'Literature 📚',sports:'Sports ⚽',entertainment:'Entertainment 🎬',technology:'Technology 💻',food:'Food 🍕',islam:'Islam 🕌',arabic:'Arabic 🏜️',animals:'Animals 🐾',flags:'Flags 🏳️'},
};

let S = {
  lang:'ar', avatar:AVATARS[0], name:'', room:null, host:false, me:null,
  screen:'landing', answered:false, voted:false, rs:null, action:'create',
  dbg:false, picker:false,
};

let timerMax = 30;

const $=s=>document.querySelector(s);
const $$=s=>document.querySelectorAll(s);
const show=id=>{$$('.screen').forEach(s=>s.classList.remove('active'));$(`#screen-${id}`)?.classList.add('active');S.screen=id;};
const toast=m=>{const t=$('#toast');t.textContent=m;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2500);};
const esc=s=>{const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;};
const catL=c=>(CAT[S.lang]||CAT.ar)[c]||c;

function setLang(l){
  S.lang=l;
  document.body.classList.toggle('en',l==='en');
  document.documentElement.dir=l==='ar'?'rtl':'ltr';
  document.documentElement.lang=l;
  $$('.lang-btn').forEach(b=>b.classList.toggle('active',b.dataset.lang===l));
  $('#logo-desc').textContent=l==='ar'?'تحدى أصدقاءك في أسئلة المعرفة!':'Challenge your friends with trivia!';
  $('#t-create').textContent=l==='ar'?'انشئ غرفة':'Create Room';
  $('#t-joinRoom').textContent=l==='ar'?'انضم لغرفة':'Join Room';
}

// AVATARS
function initAvatars(){
  const g=$('#avatar-grid');g.innerHTML='';
  AVATARS.forEach(a=>{
    const b=document.createElement('button');
    b.className=`avatar-opt${a===S.avatar?' on':''}`;
    b.textContent=a;
    b.onclick=()=>{$$('.avatar-opt').forEach(o=>o.classList.remove('on'));b.classList.add('on');S.avatar=a;};
    g.appendChild(b);
  });
}

// LANDING
$('#btn-create').onclick=()=>{S.action='create';initAvatars();show('profile');};
$('#btn-join-toggle').onclick=()=>$('#join-group').classList.toggle('hidden');
$('#btn-join').onclick=()=>{
  const c=$('#input-code').value.trim().toUpperCase();
  if(!c||c.length<4){toast('Enter code');return;}
  S.action='join';S.room=c;initAvatars();show('profile');
};
$$('.lang-btn').forEach(b=>{b.onclick=()=>setLang(b.dataset.lang);});

// PROFILE
$('#btn-ready').onclick=()=>{
  const n=$('#input-name').value.trim();
  if(!n){toast(S.lang==='ar'?'أدخل اسمك':'Enter name');$('#input-name').focus();return;}
  S.name=n;
  if(S.action==='create'){
    socket.emit('room:create',{name:n,avatar:S.avatar},r=>{
      if(r.success){S.room=r.code;S.host=true;S.me=socket.id;show('lobby');}
      else toast(r.error);
    });
  } else {
    socket.emit('room:join',{code:S.room,name:n,avatar:S.avatar},r=>{
      if(r.success){S.room=r.code;S.host=false;S.me=socket.id;show('lobby');}
      else toast(r.error);
    });
  }
};

// LOBBY
function updLobby(){
  const r=S.rs;if(!r)return;
  $('#lobby-code').textContent=r.code;
  const g=$('#lobby-players');g.innerHTML='';
  r.players.forEach(p=>{
    const d=document.createElement('div');
    d.className=`p-card${p.id===r.hostId?' host':''}${!p.connected?' off':''}`;
    let kb='';
    if(S.host&&p.id!==socket.id&&r.state==='lobby')
      kb=`<button class="kick-x" data-pid="${p.id}">✕</button>`;
    d.innerHTML=`${kb}<div class="p-av">${esc(p.avatar)}</div><div class="p-nm">${esc(p.name)}</div>${p.score>0?`<div class="p-sc">${p.score}</div>`:''}`;
    g.appendChild(d);
  });
  g.querySelectorAll('.kick-x').forEach(b=>{b.onclick=e=>{e.stopPropagation();socket.emit('debug:kick',b.dataset.pid);};});
  S.host=r.hostId===socket.id;
  $('#btn-start').classList.toggle('hidden',!S.host);
  $('#wait-msg').style.display=S.host?'none':'block';
  $('#settings-box').style.display=S.host?'block':'none';
  $('#v-rounds').textContent=r.settings.rounds;
  $('#v-answerTime').textContent=r.settings.answerTime;
  $('#v-voteTime').textContent=r.settings.voteTime;
  $('#v-maxPlayers').textContent=r.settings.maxPlayers;
  $$('.chip').forEach(c=>c.classList.toggle('on',r.settings.categories.includes(c.dataset.c)));
  $$('.lang-set').forEach(b=>b.classList.toggle('active',b.dataset.lang===r.settings.lang));
  updDbgPlayers();
}

$('#btn-copy').onclick=()=>navigator.clipboard.writeText($('#lobby-code').textContent).then(()=>toast(S.lang==='ar'?'تم النسخ!':'Copied!'));
$('#btn-share').onclick=()=>navigator.clipboard.writeText(`${location.origin}?room=${$('#lobby-code').textContent}`).then(()=>toast(S.lang==='ar'?'تم نسخ الرابط!':'Link copied!'));

$$('.chip').forEach(c=>{c.onclick=()=>{
  c.classList.toggle('on');
  const cats=[...$$('.chip.on')].map(x=>x.dataset.c);
  if(!cats.length){c.classList.add('on');return;}
  socket.emit('room:settings',{categories:cats});
};});

$$('.step-btn').forEach(b=>{b.onclick=()=>{
  const s=b.dataset.s,d=parseInt(b.dataset.d),el=$(`#v-${s}`);
  let v=parseInt(el.textContent)+d;
  const lim={rounds:[1,30],answerTime:[10,120],voteTime:[10,60],maxPlayers:[2,50]};
  const[mn,mx]=lim[s]||[1,99];v=Math.max(mn,Math.min(mx,v));
  el.textContent=v;socket.emit('room:settings',{[s]:v});
};});

$$('.lang-set').forEach(b=>{b.onclick=()=>{
  $$('.lang-set').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  socket.emit('room:settings',{lang:b.dataset.lang});
  setLang(b.dataset.lang);
};});

$('#btn-start').onclick=()=>socket.emit('game:start');

// CHAT
$('#btn-chat').onclick=sendChat;
$('#inp-chat').onkeydown=e=>{if(e.key==='Enter')sendChat();};
function sendChat(){const i=$('#inp-chat'),t=i.value.trim();if(!t)return;socket.emit('chat:send',t);i.value='';}
socket.on('chat:msg',m=>{
  const c=$('#chat-msgs'),d=document.createElement('div');
  d.className=`chat-m ${m.t==='sys'?'sys':'pl'}`;
  d.innerHTML=m.t==='sys'?`<span>${esc(m.text)}</span>`:`<span class="ch-av">${esc(m.avatar)}</span><span class="ch-nm">${esc(m.name)}</span><span class="ch-tx">${esc(m.text)}</span>`;
  c.appendChild(d);c.scrollTop=c.scrollHeight;
});

// SOCKET
socket.on('room:state',r=>{S.rs=r;S.host=r.hostId===socket.id;if(r.state==='lobby'&&S.screen==='final')show('lobby');if(S.screen==='lobby')updLobby();});
socket.on('error',m=>toast(m));
socket.on('connect',()=>{S.me=socket.id;});
socket.on('kicked',()=>show('kicked'));

// TIMER
socket.on('timer:update',t=>{
  const map={picking:{t:'#pick-timer',r:'#pick-ring'},question:{t:'#q-timer',r:'#q-ring'},voting:{t:'#vt-timer',r:'#vt-ring'}};
  const c=map[S.screen];if(!c)return;
  $(c.t).textContent=t;
  const circ=2*Math.PI*44,p=1-(t/timerMax);
  $(c.r).style.strokeDashoffset=circ*p;
  $(c.r).classList.remove('warn','danger');
  if(t<=5)$(c.r).classList.add('danger');
  else if(t<=10)$(c.r).classList.add('warn');
});
socket.on('timer:paused',p=>$('#paused').classList.toggle('hidden',!p));

// CATEGORY PICK
socket.on('game:pick',d=>{
  show('picking');
  timerMax=15;
  S.picker=d.pickerId===socket.id;
  $('#pick-round').textContent=`${S.lang==='ar'?'الجولة':'Round'} ${d.round}/${d.totalRounds}`;
  $('#pick-avatar').textContent=d.pickerAvatar;
  $('#pick-name').textContent=d.pickerName;
  $('#pick-label').textContent=S.lang==='ar'?'يختار الموضوع':'is picking the topic';

  const cats=$('#pick-cats');cats.innerHTML='';
  d.categories.forEach(c=>{
    const b=document.createElement('button');
    b.className='pick-cat-btn';
    b.textContent=catL(c);
    b.dataset.cat=c;
    if(S.picker){
      b.onclick=()=>{
        $$('.pick-cat-btn').forEach(x=>{x.disabled=true;x.classList.remove('picked');});
        b.classList.add('picked');
        socket.emit('game:pickCategory',c);
      };
    } else {
      b.disabled=true;
    }
    cats.appendChild(b);
  });

  $('#pick-wait').classList.toggle('hidden',S.picker);
});

// QUESTION
socket.on('game:question',d=>{
  S.answered=false;show('question');
  timerMax=S.rs?.settings?.answerTime||30;
  $('#q-round').textContent=`${d.round}/${d.totalRounds}`;
  $('#q-cat').textContent=catL(d.category);
  $('#q-num').textContent=`Q${d.round}`;
  $('#q-text').textContent=d.question;
  $('#inp-ans').value='';$('#inp-ans').disabled=false;
  $('#btn-ans').disabled=false;$('#ans-status').textContent='';
  $('#inp-ans').focus();
});

$('#btn-ans').onclick=()=>{
  const a=$('#inp-ans').value.trim();
  if(!a){$('#inp-ans').style.animation='shake .4s ease';setTimeout(()=>$('#inp-ans').style.animation='',400);return;}
  socket.emit('game:answer',a);S.answered=true;
  $('#inp-ans').disabled=true;$('#btn-ans').disabled=true;
  $('#ans-status').textContent=S.lang==='ar'?'✓ تم الإرسال':'✓ Submitted';
};
$('#inp-ans').onkeydown=e=>{if(e.key==='Enter'&&!S.answered)$('#btn-ans').click();};

socket.on('game:answered',({count,total})=>{
  if(S.screen==='question'){
    const sub=S.lang==='ar'?'✓ تم الإرسال':'✓ Submitted';
    const ans=S.lang==='ar'?'أجاب':'Answered';
    $('#ans-status').textContent=S.answered?`${sub} (${count}/${total})`:`${ans} ${count}/${total}`;
  }
});

// VOTING
socket.on('game:vote',d=>{
  S.voted=false;show('voting');
  timerMax=S.rs?.settings?.voteTime||20;
  $('#vt-round').textContent=`${d.round}/${d.totalRounds}`;
  $('#t-voteTitle').textContent=S.lang==='ar'?'اختر الإجابة الصحيحة!':'Pick the correct answer!';
  const c=$('#vote-list');c.innerHTML='';
  d.options.forEach((o,i)=>{
    const b=document.createElement('button');
    b.className='vote-btn';b.textContent=o.text;
    b.style.animationDelay=`${i*.05}s`;
    b.onclick=()=>{
      if(S.voted)return;S.voted=true;
      socket.emit('game:vote',o.id);
      $$('.vote-btn').forEach(x=>{x.classList.remove('sel');x.disabled=true;});
      b.classList.add('sel');
      $('#vote-status').textContent=S.lang==='ar'?'✓ تم التصويت':'✓ Voted';
    };
    c.appendChild(b);
  });
  $('#vote-status').textContent='';
});

socket.on('game:voted',({count,total})=>{
  if(S.screen==='voting'){
    const v=S.lang==='ar'?'✓ تم التصويت':'✓ Voted';
    $('#vote-status').textContent=S.voted?`${v} (${count}/${total})`:`${count}/${total}`;
  }
});

// RESULTS
socket.on('game:results',d=>{
  show('results');
  const r=S.rs;if(!r)return;
  const ar=S.lang==='ar';

  $('#correct-box').innerHTML=`<div class="cor-label">${ar?'الإجابة الصحيحة':'Correct Answer'}</div><div class="cor-text">${esc(d.correctAnswer)}</div>`;

  // Breakdown
  const bd=$('#breakdown');
  let h=`<div class="bd-title">${ar?'تفصيل الإجابات':'Answer Breakdown'}</div><div class="bd-list">`;
  d.options.forEach((o,i)=>{
    const isC=o.pid==='__correct__';
    const voters=[];
    for(const[vid,vi] of Object.entries(d.votes)){if(parseInt(vi)===i)voters.push({n:d.names[vid],a:d.avatars[vid]});}
    h+=`<div class="bd-item${isC?' correct':''}"><div class="bd-top"><span class="bd-badge">${isC?'✓':esc(o.avatar||'?')}</span><div><div class="bd-text">${esc(o.text)}</div><div class="bd-author">${isC?(ar?'الإجابة الصحيحة':'Correct'):esc(o.name)}</div></div></div>`;
    if(voters.length)h+=`<div class="bd-voters">${voters.map(v=>`<span class="voter">${esc(v.a)} ${esc(v.n)}</span>`).join('')}</div>`;
    h+=`</div>`;
  });
  h+=`</div>`;bd.innerHTML=h;

  // Player scores
  const rl=$('#res-list');rl.innerHTML='';
  r.players.forEach(p=>{
    const sc=d.roundScores[p.id];if(!sc)return;
    const item=document.createElement('div');item.className='res-item';
    let det=[];
    if(sc.correct)det.push(ar?'أصاب ✓':'Correct ✓');
    if(sc.fooled>0)det.push(`${ar?'خدع':'Fooled'} ${sc.fooled}`);
    item.innerHTML=`<div class="p-av">${esc(p.avatar)}</div><div class="res-info"><div class="res-nm">${esc(p.name)}</div><div class="res-det">${det.join(' · ')||'—'}</div></div><div class="res-pts ${sc.points>0?'pos':'zero'}">${sc.points>0?'+':''}${sc.points}</div>`;
    rl.appendChild(item);
  });

  // Scoreboard
  const sb=$('#sb-mini');
  const sorted=[...r.players].sort((a,b)=>(d.totalScores[b.id]||0)-(d.totalScores[a.id]||0));
  let sH=`<h4>${ar?'لوحة النتائج':'Scoreboard'}</h4>`;
  sorted.forEach((p,i)=>{
    const rc=i===0?'g':i===1?'s':i===2?'b':'';
    sH+=`<div class="sc-row"><span class="sc-rank ${rc}">${i+1}</span><span style="font-size:18px">${esc(p.avatar)}</span><span class="sc-nm">${esc(p.name)}</span><span class="sc-val">${d.totalScores[p.id]||0}</span></div>`;
  });
  sb.innerHTML=sH;

  const nb=$('#btn-next');
  if(S.host){nb.classList.remove('hidden');nb.textContent=r.currentRound>=r.totalRounds?(ar?'النتائج النهائية 🏆':'Final Results 🏆'):(ar?'التالي ➡️':'Next ➡️');}
  else nb.classList.add('hidden');
});

$('#btn-next').onclick=()=>socket.emit('game:next');

// FINAL
socket.on('game:end',d=>{
  show('final');confetti();
  const p=$('#podium');p.innerHTML='';
  const ord=[1,0,2],cls=['p2','p1','p3'];
  ord.forEach((i,di)=>{
    const pl=d.players[i];if(!pl)return;
    const e=document.createElement('div');e.className='pod';e.style.animationDelay=`${di*.15}s`;
    e.innerHTML=`<div class="pod-av">${esc(pl.avatar)}</div><div class="pod-nm">${esc(pl.name)}</div><div class="pod-bar ${cls[di]}">${pl.score}</div>`;
    p.appendChild(e);
  });
  const fs=$('#final-sb');let h='';
  d.players.forEach((pl,i)=>{
    const rc=i===0?'g':i===1?'s':i===2?'b':'';
    h+=`<div class="sc-row"><span class="sc-rank ${rc}">${i+1}</span><span style="font-size:18px">${esc(pl.avatar)}</span><span class="sc-nm">${esc(pl.name)}</span><span class="sc-val">${pl.score}</span></div>`;
  });
  fs.innerHTML=h;
});

$('#btn-again').onclick=()=>{socket.emit('game:restart');show('lobby');};
$('#btn-home').onclick=()=>location.reload();

// CONFETTI
function confetti(){
  const c=$('#confetti');c.innerHTML='';
  const cols=['#7c3aed','#f472b6','#facc15','#22d3ee','#34d399','#f87171','#a78bfa','#fb923c'];
  for(let i=0;i<50;i++){
    const p=document.createElement('div');p.className='conf';
    p.style.left=Math.random()*100+'%';
    p.style.background=cols[Math.floor(Math.random()*cols.length)];
    p.style.animationDelay=Math.random()*2+'s';
    p.style.animationDuration=(2+Math.random()*3)+'s';
    const sz=5+Math.random()*7;
    p.style.width=sz+'px';p.style.height=sz*(.4+Math.random()*.6)+'px';
    c.appendChild(p);
  }
  setTimeout(()=>c.innerHTML='',6000);
}

// DEBUG
window.debug=function(){
  if(!S.host){console.log('%c⚠️ Host only','color:#f87171;font-size:14px');return;}
  S.dbg=!S.dbg;$('#debug').classList.toggle('hidden',!S.dbg);
  if(S.dbg)updDbgPlayers();
  console.log(`%c🛠️ Debug ${S.dbg?'ON':'OFF'}`,'color:#22d3ee;font-size:14px;font-weight:bold');
};
document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.shiftKey&&e.key==='D'){e.preventDefault();window.debug();}});

$('#dbg-x').onclick=()=>{S.dbg=false;$('#debug').classList.add('hidden');};
$('#d-pause').onclick=()=>socket.emit('debug:pause');
$('#d-skip').onclick=()=>socket.emit('debug:skip');
$('#d-end').onclick=()=>{if(confirm('End game?'))socket.emit('debug:endGame');};
$('#d-add').onclick=()=>socket.emit('debug:addRounds',5);
$('#d-ref').onclick=()=>{
  socket.emit('debug:getAnswers',null,d=>{
    const el=$('#d-ans');
    if(!d||!d.answers||!Object.keys(d.answers).length){el.innerHTML='<div class="d-empty">No answers</div>';return;}
    let h=`<div class="d-cor">✓ ${esc(d.correct)}</div>`;
    for(const[,info] of Object.entries(d.answers)){
      const m=info.answer.trim().toLowerCase()===d.correct?.trim().toLowerCase();
      h+=`<div class="d-arow${m?' match':''}">${esc(info.avatar)} ${esc(info.name)}: ${esc(info.answer)}</div>`;
    }
    el.innerHTML=h;
  });
};

function updDbgPlayers(){
  if(!S.dbg||!S.rs)return;
  const el=$('#d-players');let h='';
  S.rs.players.forEach(p=>{
    if(p.id===socket.id)return;
    h+=`<div class="d-prow"><span>${esc(p.avatar)} ${esc(p.name)} (${p.score})</span><div class="d-pbtns"><button class="d-pbtn d-kick" data-p="${p.id}">Kick</button><button class="d-pbtn d-host" data-p="${p.id}">Host</button></div></div>`;
  });
  el.innerHTML=h||'<div class="d-empty">No players</div>';
  el.querySelectorAll('.d-kick').forEach(b=>{b.onclick=()=>socket.emit('debug:kick',b.dataset.p);});
  el.querySelectorAll('.d-host').forEach(b=>{b.onclick=()=>socket.emit('debug:transferHost',b.dataset.p);});
}

setInterval(()=>{if(S.dbg&&S.screen==='question')$('#d-ref').click();},3000);

// URL room param
const urlRoom=new URLSearchParams(location.search).get('room');
if(urlRoom){S.action='join';S.room=urlRoom.toUpperCase();setTimeout(()=>{initAvatars();show('profile');},100);}

// INIT
$('#input-code').oninput=e=>{e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'');};
setLang('ar');
console.log('%c🎮 كَلَك | Kalak','color:#7c3aed;font-size:20px;font-weight:bold');
console.log('%cType debug() or Ctrl+Shift+D for host panel','color:#a78bfa;font-size:11px');
