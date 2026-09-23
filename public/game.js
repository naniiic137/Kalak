const socket = io();

const AVATARS = ['😎','🤖','👾','🎮','🕹️','🦊','🐱','🐶','🦁','🐸','🐵','🦄','🐲','🎃','👻','🤠','🥷','🧙','🦸','🧛','🐼','🦋','🐙','🦖','🎭','🤡','🐺','🦅','🐝','🎯'];
const MAX_ANSWER = 60;

const CAT = {
  ar:{general:'عام 🌍',geography:'جغرافيا 🗺️',history:'تاريخ 📜',science:'علوم 🔬',literature:'أدب 📚',sports:'رياضة ⚽',entertainment:'ترفيه 🎬',technology:'تقنية 💻',food:'طعام 🍕',islam:'إسلام 🕌',arabic:'عربي 🏜️',animals:'حيوانات 🐾',flags:'أعلام 🏳️'},
  en:{general:'General 🌍',geography:'Geography 🗺️',history:'History 📜',science:'Science 🔬',literature:'Literature 📚',sports:'Sports ⚽',entertainment:'Entertainment 🎬',technology:'Technology 💻',food:'Food 🍕',islam:'Islam 🕌',arabic:'Arab world 🏜️',animals:'Animals 🐾',flags:'Flags 🏳️'},
};

const TXT = {
  ar:{
    tagline:'تحدى أصدقاءك في أسئلة المعرفة!', create:'انشئ غرفة', joinRoom:'انضم لغرفة', join:'انضم',
    chooseChar:'اختر شخصيتك', namePh:'اسمك', ready:'يلا نلعب! 🎯',
    lobby:'غرفة الانتظار', roomCode:'كود الغرفة', settings:'إعدادات اللعبة', cats:'الفئات', rounds:'الجولات',
    atime:'وقت الإجابة', vtime:'وقت التصويت', maxp:'الحد الأقصى', lang:'اللغة', start:'ابدأ اللعبة! 🚀',
    waitHost:'في انتظار المضيف…', chatPh:'رسالة...', round:'الجولة', picking:'يختار الموضوع', youPick:'دورك! اختر الموضوع',
    waitPick:'في انتظار الاختيار…', ansPh:'اكتب إجابة مزيفة مقنعة...', submit:'إرسال ✓', submitted:'✓ تم الإرسال',
    answered:'أجاب', realAns:'هذه هي الإجابة الصحيحة — اكتب إجابة مزيفة!', voteTitle:'اختر الإجابة الصحيحة!',
    voted:'✓ تم التصويت', yours:'إجابتك', results:'النتائج 🏆', correctAnswer:'الإجابة الصحيحة',
    breakdown:'تفصيل الإجابات', gotIt:'أصاب ✓', fooled:'خدع', scoreboard:'لوحة النتائج', next:'التالي ➡️',
    finalResults:'النتائج النهائية 🏆', gameOver:'🎉 انتهت اللعبة! 🎉', noMoreQ:'انتهت أسئلة الفئات المختارة',
    again:'العب مرة ثانية 🔄', home:'الرئيسية 🏠', kicked:'تم طردك من الغرفة', replaced:'فُتحت اللعبة في نافذة أخرى',
    playHere:'العب هنا', reconnecting:'جارٍ إعادة الاتصال…', enterCode:'أدخل كود الغرفة', enterName:'أدخل اسمك',
    copied:'تم النسخ!', linkCopied:'تم نسخ الرابط!', rejoinFail:'انتهت لعبتك السابقة', and:'و',
    err_not_found:'الغرفة غير موجودة', err_kicked:'تم طردك من هذه الغرفة', err_started:'اللعبة بدأت بالفعل',
    err_full:'الغرفة ممتلئة', err_invalid:'بيانات غير صالحة', err_server:'حدث خطأ، حاول مرة أخرى',
    err_need2:'تحتاج لاعبَين على الأقل', err_own:'لا يمكنك التصويت لإجابتك', err_phase:'انتهى الوقت',
    sys_joined:'{n} انضم', sys_left:'{n} غادر', sys_kicked:'تم طرد {n}', sys_back:'{n} عاد',
  },
  en:{
    tagline:'Challenge your friends with trivia!', create:'Create Room', joinRoom:'Join Room', join:'Join',
    chooseChar:'Choose your character', namePh:'Your name', ready:"Let's play! 🎯",
    lobby:'Lobby', roomCode:'Room code', settings:'Game settings', cats:'Categories', rounds:'Rounds',
    atime:'Answer time', vtime:'Vote time', maxp:'Max players', lang:'Language', start:'Start game! 🚀',
    waitHost:'Waiting for host…', chatPh:'Message…', round:'Round', picking:'is picking the topic', youPick:'Your turn! Pick the topic',
    waitPick:'Waiting for the pick…', ansPh:'Write a convincing fake answer…', submit:'Submit ✓', submitted:'✓ Submitted',
    answered:'Answered', realAns:"That's the real answer — write a fake one!", voteTitle:'Pick the correct answer!',
    voted:'✓ Voted', yours:'Your answer', results:'Results 🏆', correctAnswer:'Correct answer',
    breakdown:'Answer breakdown', gotIt:'Correct ✓', fooled:'Fooled', scoreboard:'Scoreboard', next:'Next ➡️',
    finalResults:'Final results 🏆', gameOver:'🎉 Game over! 🎉', noMoreQ:'No questions left in the chosen categories',
    again:'Play again 🔄', home:'Home 🏠', kicked:'You were removed from the room', replaced:'The game was opened in another tab',
    playHere:'Play here', reconnecting:'Reconnecting…', enterCode:'Enter the room code', enterName:'Enter your name',
    copied:'Copied!', linkCopied:'Link copied!', rejoinFail:'Your previous game has ended', and:'&',
    err_not_found:'Room not found', err_kicked:'You were removed from this room', err_started:'Game already started',
    err_full:'Room is full', err_invalid:'Invalid input', err_server:'Something went wrong, try again',
    err_need2:'You need at least 2 players', err_own:"You can't vote for your own answer", err_phase:'Time is up',
    sys_joined:'{n} joined', sys_left:'{n} left', sys_kicked:'{n} was removed', sys_back:'{n} is back',
  },
};

// ---------- storage (may be unavailable in private mode) ----------
const store = {
  get(k){try{return localStorage.getItem(k);}catch{return null;}},
  set(k,v){try{localStorage.setItem(k,v);}catch{/* ignore */}},
  del(k){try{localStorage.removeItem(k);}catch{/* ignore */}},
};
function makeToken(){
  const b=new Uint8Array(16);
  try{crypto.getRandomValues(b);}catch{for(let i=0;i<16;i++)b[i]=Math.floor(Math.random()*256);}
  return [...b].map(x=>x.toString(16).padStart(2,'0')).join('');
}
// One persistent token per browser: lets a player reload or reconnect into the same seat.
let TOKEN=store.get('kalak_token');
if(!TOKEN||!/^[A-Za-z0-9_-]{16,64}$/.test(TOKEN)){TOKEN=makeToken();store.set('kalak_token',TOKEN);}
const session={
  get(){try{return JSON.parse(store.get('kalak_session')||'null');}catch{return null;}},
  save(code){store.set('kalak_session',JSON.stringify({code,at:Date.now()}));},
  clear(){store.del('kalak_session');},
};

let S = {
  lang:'ar', avatar:AVATARS[Math.floor(Math.random()*AVATARS.length)], name:'', room:null, host:false, me:null,
  screen:'landing', answered:false, voted:false, rs:null, action:'create', picker:false,
  results:null, end:null, pick:null, vote:null,
};

const $=s=>document.querySelector(s);
const $$=s=>document.querySelectorAll(s);
const show=id=>{$$('.screen').forEach(s=>s.classList.remove('active'));$(`#screen-${id}`)?.classList.add('active');S.screen=id;};
const toast=m=>{const t=$('#toast');t.textContent=m;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2800);};
const esc=s=>{const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;};
const t=k=>(TXT[S.lang]||TXT.ar)[k]??TXT.en[k]??k;
const errText=e=>t('err_'+(e||'server'));
const catL=c=>(CAT[S.lang]||CAT.ar)[c]||c;
const rankCls=r=>r===1?'g':r===2?'s':r===3?'b':'';
// Competition ranking: equal scores share a rank (1, 1, 3…).
const withRanks=(players,scoreOf)=>{
  const sorted=[...players].sort((a,b)=>scoreOf(b)-scoreOf(a));
  return sorted.map(p=>({...p,rank:1+sorted.filter(o=>scoreOf(o)>scoreOf(p)).length}));
};
// Signed numbers like "+1" must stay LTR inside Arabic text (otherwise they render as "1+").
const signed=n=>`\u2066${n>0?'+':''}${n}\u2069`;

function setLang(l){
  if(l!=='ar'&&l!=='en')l='ar';
  S.lang=l;
  document.body.classList.toggle('en',l==='en');
  document.documentElement.dir=l==='ar'?'rtl':'ltr';
  document.documentElement.lang=l;
  $$('.lang-btn').forEach(b=>b.classList.toggle('active',b.dataset.lang===l));
  $$('[data-i18n]').forEach(e=>{e.textContent=t(e.dataset.i18n);});
  $$('[data-i18n-ph]').forEach(e=>{e.placeholder=t(e.dataset.i18nPh);});
  $$('.chip').forEach(c=>{c.textContent=catL(c.dataset.c);});
  $$('.pick-cat-btn').forEach(b=>{b.textContent=catL(b.dataset.cat);});
  document.title=l==='ar'?'كَلَك | Kalak':'Kalak | كَلَك';
  // Re-render whatever is on screen so dynamic labels switch too.
  if(S.screen==='lobby')updLobby();
  if(S.screen==='picking'&&S.pick)renderPick(S.pick);
  if(S.screen==='results'&&S.results)renderResults(S.results);
  if(S.screen==='final'&&S.end)renderFinal(S.end,false);
  updHostControls();
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
  const saved=store.get('kalak_name');
  if(saved&&!$('#input-name').value)$('#input-name').value=saved;
}

// LANDING
$('#btn-create').onclick=()=>{S.action='create';initAvatars();show('profile');};
$('#btn-join-toggle').onclick=()=>$('#join-group').classList.toggle('hidden');
$('#btn-join').onclick=()=>{
  const c=$('#input-code').value.trim().toUpperCase();
  if(!c||c.length<4){toast(t('enterCode'));return;}
  S.action='join';S.joinCode=c;initAvatars();show('profile');
};
$('#input-code').onkeydown=e=>{if(e.key==='Enter')$('#btn-join').click();};
$$('.lang-btn').forEach(b=>{b.onclick=()=>{setLang(b.dataset.lang);store.set('kalak_lang',b.dataset.lang);};});

function enterRoom(r){
  S.room=r.code;S.me=r.playerId;
  session.save(r.code);
  $('#chat-msgs').innerHTML='';
  (r.chat||[]).forEach(addChat);
  if(r.state==='lobby')show('lobby');
}

// PROFILE
$('#btn-ready').onclick=()=>{
  const n=$('#input-name').value.trim();
  if(!n){toast(t('enterName'));$('#input-name').focus();return;}
  S.name=n;store.set('kalak_name',n);
  const btn=$('#btn-ready');btn.disabled=true;
  const done=r=>{btn.disabled=false;if(r&&r.success)enterRoom(r);else toast(errText(r&&r.error));};
  if(S.action==='create')socket.emit('room:create',{name:n,avatar:S.avatar,token:TOKEN,lang:S.lang},done);
  else socket.emit('room:join',{code:S.joinCode,name:n,avatar:S.avatar,token:TOKEN},done);
};
$('#input-name').onkeydown=e=>{if(e.key==='Enter')$('#btn-ready').click();};

// LOBBY
function updLobby(){
  const r=S.rs;if(!r)return;
  $('#lobby-code').textContent=r.code;
  const g=$('#lobby-players');g.innerHTML='';
  r.players.forEach(p=>{
    const d=document.createElement('div');
    d.className=`p-card${p.id===r.hostId?' host':''}${!p.connected?' off':''}${p.id===S.me?' me':''}`;
    let kb='';
    if(S.host&&p.id!==S.me&&r.state==='lobby')
      kb=`<button class="kick-x" data-pid="${esc(p.id)}" aria-label="kick">✕</button>`;
    d.innerHTML=`${kb}<div class="p-av">${esc(p.avatar)}</div><div class="p-nm">${esc(p.name)}</div>${p.score>0?`<div class="p-sc">${p.score}</div>`:''}`;
    g.appendChild(d);
  });
  g.querySelectorAll('.kick-x').forEach(b=>{b.onclick=e=>{e.stopPropagation();socket.emit('room:kick',b.dataset.pid);};});
  $('#btn-start').classList.toggle('hidden',!S.host);
  $('#wait-msg').style.display=S.host?'none':'block';
  $('#settings-box').style.display=S.host?'block':'none';
  $('#v-rounds').textContent=r.settings.rounds;
  $('#v-answerTime').textContent=r.settings.answerTime;
  $('#v-voteTime').textContent=r.settings.voteTime;
  $('#v-maxPlayers').textContent=r.settings.maxPlayers;
  $$('.chip').forEach(c=>c.classList.toggle('on',r.settings.categories.includes(c.dataset.c)));
  $$('.lang-set').forEach(b=>b.classList.toggle('active',b.dataset.lang===r.settings.lang));
}

$('#btn-copy').onclick=()=>navigator.clipboard?.writeText($('#lobby-code').textContent).then(()=>toast(t('copied')));
$('#btn-share').onclick=()=>navigator.clipboard?.writeText(`${location.origin}${location.pathname}?room=${$('#lobby-code').textContent}`).then(()=>toast(t('linkCopied')));

$$('.chip').forEach(c=>{c.onclick=()=>{
  c.classList.toggle('on');
  const cats=[...$$('.chip.on')].map(x=>x.dataset.c);
  if(!cats.length){c.classList.add('on');return;}
  socket.emit('room:settings',{categories:cats});
};});

$$('.step-btn').forEach(b=>{b.onclick=()=>{
  const s=b.dataset.s,d=parseInt(b.dataset.d,10),el=$(`#v-${s}`);
  let v=parseInt(el.textContent,10)+d;
  const lim={rounds:[1,30],answerTime:[10,120],voteTime:[10,60],maxPlayers:[2,50]};
  const[mn,mx]=lim[s]||[1,99];v=Math.max(mn,Math.min(mx,v));
  el.textContent=v;socket.emit('room:settings',{[s]:v});
};});

$$('.lang-set').forEach(b=>{b.onclick=()=>{
  $$('.lang-set').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  socket.emit('room:settings',{lang:b.dataset.lang});
};});

$('#btn-start').onclick=()=>socket.emit('game:start');

// CHAT
$('#btn-chat').onclick=sendChat;
$('#inp-chat').onkeydown=e=>{if(e.key==='Enter')sendChat();};
function sendChat(){const i=$('#inp-chat'),v=i.value.trim();if(!v)return;socket.emit('chat:send',v);i.value='';}
function addChat(m){
  const c=$('#chat-msgs'),d=document.createElement('div');
  d.className=`chat-m ${m.t==='sys'?'sys':'pl'}`;
  d.innerHTML=m.t==='sys'
    ?`<span>${esc(t('sys_'+m.key).replace('{n}',m.name))}</span>`
    :`<span class="ch-av">${esc(m.avatar)}</span><span class="ch-nm">${esc(m.name)}</span><span class="ch-tx">${esc(m.text)}</span>`;
  c.appendChild(d);c.scrollTop=c.scrollHeight;
}
socket.on('chat:msg',addChat);

// CONNECTION / RECONNECT
function resume(){
  const code=S.room||session.get()?.code;
  if(!code)return;
  const wasIn=!!S.room;
  socket.emit('room:resume',{code,token:TOKEN},r=>{
    if(r&&r.success){enterRoom(r);return;}
    session.clear();
    if(wasIn){S.room=null;S.me=null;toast(t('rejoinFail'));show('landing');}
  });
}
socket.on('connect',()=>{$('#net').classList.add('hidden');resume();});
socket.on('disconnect',reason=>{
  if(S.room&&reason!=='io server disconnect'&&reason!=='io client disconnect')$('#net').classList.remove('hidden');
});
socket.on('session:replaced',()=>{S.room=null;show('replaced');});
socket.on('kicked',()=>{S.room=null;session.clear();show('kicked');});
socket.on('error',m=>toast(errText(m)));

function updHostControls(){
  const r=S.rs;if(!r)return;
  if(S.screen==='results'&&S.results){
    const nb=$('#btn-next');
    nb.classList.toggle('hidden',!S.host);
    nb.textContent=S.results.isLast?t('finalResults'):t('next');
    $('#next-wait').classList.toggle('hidden',S.host);
  }
  if(S.screen==='final'){
    $('#btn-again').classList.toggle('hidden',!S.host);
    $('#again-wait').classList.toggle('hidden',S.host);
  }
}

socket.on('room:state',r=>{
  S.rs=r;S.host=r.hostId===S.me;
  if(r.settings.lang!==S.lang)setLang(r.settings.lang);
  if(r.state==='lobby'&&S.screen!=='lobby'&&S.room)show('lobby');
  if(S.screen==='lobby')updLobby();
  updHostControls();
});

// TIMER
socket.on('timer:update',({left,max})=>{
  const map={picking:{t:'#pick-timer',r:'#pick-ring'},question:{t:'#q-timer',r:'#q-ring'},voting:{t:'#vt-timer',r:'#vt-ring'}};
  const c=map[S.screen];if(!c)return;
  $(c.t).textContent=left;
  const circ=2*Math.PI*44,p=1-(left/(max||1));
  $(c.r).style.strokeDashoffset=circ*p;
  $(c.r).classList.remove('warn','danger');
  if(left<=5)$(c.r).classList.add('danger');
  else if(left<=10)$(c.r).classList.add('warn');
});

// CATEGORY PICK
function renderPick(d){
  S.picker=d.pickerId===S.me;
  $('#pick-round').textContent=`${t('round')} ${d.round}/${d.totalRounds}`;
  $('#pick-avatar').textContent=d.pickerAvatar||'🎲';
  $('#pick-name').textContent=S.picker?'':(d.pickerName||'');
  $('#pick-label').textContent=S.picker?t('youPick'):t('picking');
  const cats=$('#pick-cats');cats.innerHTML='';
  d.categories.forEach(c=>{
    const b=document.createElement('button');
    b.className='pick-cat-btn';b.textContent=catL(c);b.dataset.cat=c;
    if(S.picker){
      b.onclick=()=>{
        $$('.pick-cat-btn').forEach(x=>{x.disabled=true;x.classList.remove('picked');});
        b.classList.add('picked');
        socket.emit('game:pickCategory',c);
      };
    } else b.disabled=true;
    cats.appendChild(b);
  });
  $('#pick-wait').classList.toggle('hidden',S.picker);
}
socket.on('game:pick',d=>{S.pick=d;show('picking');renderPick(d);});

// QUESTION
socket.on('game:question',d=>{
  S.answered=!!d.answered;show('question');
  $('#q-round').textContent=`${d.round}/${d.totalRounds}`;
  $('#q-cat').textContent=catL(d.category);
  $('#q-num').textContent=`Q${d.round}`;
  $('#q-text').textContent=d.question;
  const inp=$('#inp-ans');
  inp.value=d.myAnswer||'';inp.disabled=S.answered;
  $('#btn-ans').disabled=S.answered;
  setAnsStatus(S.answered?t('submitted'):'');
  if(!S.answered)inp.focus();
});

function setAnsStatus(text,isErr){const el=$('#ans-status');el.textContent=text;el.classList.toggle('err',!!isErr);}
function shake(el){el.style.animation='shake .4s ease';setTimeout(()=>el.style.animation='',400);}

$('#btn-ans').onclick=()=>{
  const inp=$('#inp-ans'),a=inp.value.trim().slice(0,MAX_ANSWER);
  if(!a||S.answered){shake(inp);return;}
  $('#btn-ans').disabled=true;
  socket.emit('game:answer',a,r=>{
    if(r&&(r.success||r.error==='already')){
      S.answered=true;inp.disabled=true;
      setAnsStatus(t('submitted'));
      return;
    }
    $('#btn-ans').disabled=false;
    if(r&&r.error==='real'){setAnsStatus(t('realAns'),true);shake(inp);inp.select();}
    else setAnsStatus(errText(r&&r.error),true);
  });
};
$('#inp-ans').onkeydown=e=>{if(e.key==='Enter'&&!S.answered)$('#btn-ans').click();};
$('#inp-ans').oninput=()=>{if($('#ans-status').classList.contains('err'))setAnsStatus('');};

socket.on('game:answered',({count,total})=>{
  if(S.screen!=='question'||$('#ans-status').classList.contains('err'))return;
  setAnsStatus(S.answered?`${t('submitted')} (${count}/${total})`:`${t('answered')} ${count}/${total}`);
});

// VOTING
socket.on('game:vote',d=>{
  S.vote=d;S.voted=d.voted!=null;show('voting');
  $('#vt-round').textContent=`${d.round}/${d.totalRounds}`;
  $('#vt-q').textContent=d.question||'';
  const c=$('#vote-list');c.innerHTML='';
  d.options.forEach((o,i)=>{
    const b=document.createElement('button');
    b.className=`vote-btn${o.own?' own':''}${d.voted===o.id?' sel':''}`;
    b.style.animationDelay=`${i*.05}s`;
    b.innerHTML=`<span class="vote-tx">${esc(o.text)}</span>${o.own?`<span class="vote-own">${esc(t('yours'))}</span>`:''}`;
    b.disabled=o.own||S.voted;
    if(!o.own)b.onclick=()=>{
      if(S.voted)return;S.voted=true;
      $$('.vote-btn').forEach(x=>{x.classList.remove('sel');x.disabled=true;});
      b.classList.add('sel');
      socket.emit('game:vote',o.id,r=>{
        if(r&&r.success){$('#vote-status').textContent=t('voted');return;}
        if(r&&r.error==='already')return;
        S.voted=false;b.classList.remove('sel');
        $$('.vote-btn').forEach((x,j)=>{x.disabled=!!d.options[j].own;});
        toast(errText(r&&r.error));
      });
    };
    c.appendChild(b);
  });
  $('#vote-status').textContent=S.voted?t('voted'):'';
});

socket.on('game:voted',({count,total})=>{
  if(S.screen==='voting')$('#vote-status').textContent=S.voted?`${t('voted')} (${count}/${total})`:`${count}/${total}`;
});

// RESULTS
function renderResults(d){
  $('#correct-box').innerHTML=`<div class="cor-q">${esc(d.question)}</div><div class="cor-label">${esc(t('correctAnswer'))}</div><div class="cor-text">${esc(d.correctAnswer)}</div>`;

  let h=`<div class="bd-title">${esc(t('breakdown'))}</div><div class="bd-list">`;
  d.options.forEach(o=>{
    const authors=o.correct?esc(t('correctAnswer')):o.authors.map(a=>esc(a.name)).join(` ${esc(t('and'))} `);
    const badge=o.correct?'✓':esc(o.authors.map(a=>a.avatar).join(''));
    h+=`<div class="bd-item${o.correct?' correct':''}"><div class="bd-top"><span class="bd-badge">${badge}</span><div class="bd-body"><div class="bd-text">${esc(o.text)}</div><div class="bd-author">${authors}</div></div></div>`;
    if(o.voters.length)h+=`<div class="bd-voters">${o.voters.map(v=>`<span class="voter">${esc(v.avatar)} ${esc(v.name)}</span>`).join('')}</div>`;
    h+=`</div>`;
  });
  $('#breakdown').innerHTML=h+`</div>`;

  const rl=$('#res-list');rl.innerHTML='';
  d.players.forEach(p=>{
    const sc=d.roundScores[p.id];if(!sc)return;
    const det=[];
    if(sc.correct)det.push(t('gotIt'));
    if(sc.fooled>0)det.push(`${t('fooled')} ${sc.fooled}`);
    const item=document.createElement('div');item.className='res-item';
    item.innerHTML=`<div class="p-av">${esc(p.avatar)}</div><div class="res-info"><div class="res-nm">${esc(p.name)}</div><div class="res-det">${esc(det.join(' · ')||'—')}</div></div><div class="res-pts ${sc.points>0?'pos':'zero'}" dir="ltr">${signed(sc.points)}</div>`;
    rl.appendChild(item);
  });

  let sH=`<h4>${esc(t('scoreboard'))}</h4>`;
  withRanks(d.players,p=>p.score).forEach(p=>{
    sH+=`<div class="sc-row"><span class="sc-rank ${rankCls(p.rank)}">${p.rank}</span><span class="sc-av">${esc(p.avatar)}</span><span class="sc-nm">${esc(p.name)}</span><span class="sc-val">${p.score}</span></div>`;
  });
  $('#sb-mini').innerHTML=sH;
  updHostControls();
}
socket.on('game:results',d=>{S.results=d;show('results');renderResults(d);});
$('#btn-next').onclick=()=>socket.emit('game:next');

// FINAL
function renderFinal(d,celebrate){
  $('#final-note').textContent=d.reason==='no_questions'?t('noMoreQ'):'';
  const ranked=withRanks(d.players,p=>p.score);
  const p=$('#podium');p.innerHTML='';
  [1,0,2].forEach((i,di)=>{
    const pl=ranked[i];if(!pl)return;
    const e=document.createElement('div');e.className='pod';e.style.animationDelay=`${di*.15}s`;
    e.innerHTML=`<div class="pod-av">${esc(pl.avatar)}</div><div class="pod-nm">${esc(pl.name)}</div><div class="pod-bar p${Math.min(pl.rank,3)}">${pl.score}</div>`;
    p.appendChild(e);
  });
  let h='';
  ranked.forEach(pl=>{
    h+=`<div class="sc-row"><span class="sc-rank ${rankCls(pl.rank)}">${pl.rank}</span><span class="sc-av">${esc(pl.avatar)}</span><span class="sc-nm">${esc(pl.name)}</span><span class="sc-val">${pl.score}</span></div>`;
  });
  $('#final-sb').innerHTML=h;
  if(celebrate)confetti();
  updHostControls();
}
socket.on('game:end',d=>{const first=S.screen!=='final';S.end=d;show('final');renderFinal(d,first);});

$('#btn-again').onclick=()=>socket.emit('game:restart');
function goHome(){
  S.room=null;session.clear();
  const go=()=>{location.href=location.pathname;};
  // Wait for the server to free the seat (so it doesn't linger as an offline player), but never hang.
  socket.timeout(800).emit('room:leave',go);
}
$('#btn-home').onclick=goHome;
$('#btn-kicked-home').onclick=()=>{session.clear();location.href=location.pathname;};
$('#btn-play-here').onclick=()=>location.reload();

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

// INIT
$('#input-code').oninput=e=>{e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'');};
$('#inp-ans').maxLength=MAX_ANSWER;
setLang(store.get('kalak_lang')||'ar');
const urlRoom=new URLSearchParams(location.search).get('room');
if(urlRoom&&session.get()?.code!==urlRoom.toUpperCase())session.clear();
if(urlRoom){S.action='join';S.joinCode=urlRoom.toUpperCase().replace(/[^A-Z0-9]/g,'');initAvatars();show('profile');}
