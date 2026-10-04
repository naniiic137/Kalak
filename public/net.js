// Tiny WebSocket client with a socket.io-like API, so game.js stays simple:
//   const net = new Net(); net.open(code);
//   net.emit(event, data, ack?)  net.on(event, fn)  'connect' / 'disconnect' events
// One connection per room (/ws?room=CODE). Drops are retried with backoff until close() is
// called or the server ends the session on purpose (close codes 4000-4099).
// Wire format: {t: event, d: data, id?: ackId}; the server answers acks with {ack: id, d}.
class Net {
  constructor(){
    this.room=null;this.ws=null;this.connected=false;
    this.handlers=new Map();this.acks=new Map();this.queue=[];
    this.nextId=1;this.tries=0;this.retryTimer=null;this.pingTimer=null;this.lastSeen=0;
    addEventListener('online',()=>this.retryNow());
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.retryNow();});
  }
  on(ev,fn){if(!this.handlers.has(ev))this.handlers.set(ev,new Set());this.handlers.get(ev).add(fn);return this;}
  off(ev,fn){this.handlers.get(ev)?.delete(fn);return this;}
  fire(ev,...args){for(const fn of [...(this.handlers.get(ev)||[])]){try{fn(...args);}catch(e){console.error(e);}}}

  /** Connects to a room (closing any other room's connection first). */
  open(room){
    if(this.room===room&&(this.ws||this.retryTimer))return;
    this.close();
    this.room=room;this.tries=0;this.dial();
  }
  /** Leaves on purpose: no reconnect, pending acks get a failure. */
  close(){
    this.room=null;this.queue=[];
    clearTimeout(this.retryTimer);this.retryTimer=null;
    const ws=this.ws;
    if(ws){this.lost(ws,'io client disconnect');try{ws.close(1000);}catch{/* ignore */}}
  }

  emit(ev,data,ack){
    if(typeof data==='function'){ack=data;data=undefined;}
    const m={t:ev};if(data!==undefined)m.d=data;
    const cb=typeof ack==='function'?ack:null;
    if(this.connected)this.send(m,cb);
    else if(this.room&&this.queue.length<50)this.queue.push([m,cb]); // sent after 'connect'
    else if(cb)cb({success:false,error:'server'});
    return this;
  }
  send(m,cb){
    if(cb){m.id=this.nextId++;this.acks.set(m.id,cb);}
    try{this.ws.send(JSON.stringify(m));}catch{/* the close handler fails the ack */}
  }

  dial(){
    const base=(window.GAME_SERVER||location.origin).replace(/^http/,'ws');
    const ws=new WebSocket(`${base}/ws?room=${encodeURIComponent(this.room)}`);
    this.ws=ws;
    ws.onopen=()=>{
      if(this.ws!==ws)return;
      this.tries=0;this.connected=true;this.lastSeen=Date.now();
      // Heartbeat: keeps the server from dropping us and notices a dead network.
      this.pingTimer=setInterval(()=>{
        if(Date.now()-this.lastSeen>70000){this.lost(ws,'ping timeout');try{ws.close();}catch{/* ignore */}return;}
        this.send({t:'ping'});
      },25000);
      this.fire('connect');
      const q=this.queue;this.queue=[];
      for(const [m,cb] of q)this.send(m,cb);
    };
    ws.onmessage=e=>{
      if(this.ws!==ws)return;
      this.lastSeen=Date.now();
      let m;try{m=JSON.parse(e.data);}catch{return;}
      if(!m||typeof m!=='object')return;
      if('ack' in m){const cb=this.acks.get(m.ack);this.acks.delete(m.ack);if(cb)cb(m.d);return;}
      if(typeof m.t==='string'&&m.t!=='pong')this.fire(m.t,m.d);
    };
    ws.onclose=e=>{
      if(this.ws!==ws)return;
      const final=e.code>=4000&&e.code<4100;
      if(final)this.room=null;
      this.lost(ws,final?'io server disconnect':'transport close');
    };
    ws.onerror=()=>{/* onclose follows */};
  }

  // The connection is gone: fail pending acks, tell game.js, and retry unless we were told to stop.
  lost(ws,reason){
    if(this.ws!==ws)return;
    this.ws=null;
    clearInterval(this.pingTimer);this.pingTimer=null;
    const was=this.connected;this.connected=false;
    const acks=[...this.acks.values()];this.acks.clear();
    for(const cb of acks)cb({success:false,error:'server'});
    if(was)this.fire('disconnect',reason);
    if(this.room&&reason!=='io client disconnect'){
      const delay=Math.min(5000,500*2**this.tries++)*(0.75+Math.random()*0.5);
      this.retryTimer=setTimeout(()=>{this.retryTimer=null;if(this.room&&!this.ws)this.dial();},delay);
    }
  }
  retryNow(){
    if(!this.room||this.ws||!this.retryTimer)return;
    clearTimeout(this.retryTimer);this.retryTimer=null;this.dial();
  }
}
