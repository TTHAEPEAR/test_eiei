// public/client.js (SP2: blink-fixed, incremental updates, debounced read receipts)
const socket = io();

let myName = null;
let activeRoom = null;
let messagesByRoom = new Map();
let typers = new Set();

const el = {
  meBox: document.getElementById('meBox'),
  userList: document.getElementById('userList'),
  groupList: document.getElementById('groupList'),
  newGroupName: document.getElementById('newGroupName'),
  createGroupBtn: document.getElementById('createGroupBtn'),
  groupError: document.getElementById('groupError'),
  roomHeader: document.getElementById('roomHeader'),
  roomTitle: document.getElementById('roomTitle'),
  messages: document.getElementById('messages'),
  sendForm: document.getElementById('sendForm'),
  msgInput: document.getElementById('msgInput'),
  fileInput: document.getElementById('fileInput'),
  e2eeBtn: document.getElementById('e2eeBtn')
};

// ---------- E2EE helpers ----------
let e2ee = { enabled:false, key:null, salt:null };
async function deriveKey(passphrase, salt) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name:'PBKDF2', salt:enc.encode(salt), iterations:100000, hash:'SHA-256' },
    baseKey, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
}
async function encryptText(plain) {
  if (!e2ee.enabled || !e2ee.key) return { clear: plain };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plain);
  const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, e2ee.key, enc);
  return { cipher: btoa(String.fromCharCode(...new Uint8Array(ct))), iv: btoa(String.fromCharCode(...iv)) };
}
async function decryptText(payload) {
  if (!payload.e2ee || !e2ee.enabled || !e2ee.key) return payload.text;
  try {
    const iv = Uint8Array.from(atob(payload.iv), c=>c.charCodeAt(0));
    const ct = Uint8Array.from(atob(payload.cipher), c=>c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, e2ee.key, ct);
    return new TextDecoder().decode(pt);
  } catch { return '[Encrypted]'; }
}
async function enableE2EEForRoom() {
  if (!activeRoom) return alert('Open a room first');
  const pass = prompt('Enter shared passphrase for this room');
  if (!pass) return;
  const salt = `room:${activeRoom.id}`;
  e2ee.key = await deriveKey(pass, salt);
  e2ee.enabled = true; e2ee.salt = salt;
  el.e2eeBtn.textContent = '🔒 E2EE On';
  updateHeader(); // minimal update
}

// ---------- Typing indicator (no header thrash) ----------
let typingTimer; let currentlyTyping = false;
function emitTyping(isTyping){ if (activeRoom) socket.emit('typing', { roomId: activeRoom.id, isTyping }); }
el.msgInput.addEventListener('input', ()=>{
  if (!currentlyTyping){ currentlyTyping = true; emitTyping(true); }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(()=>{ currentlyTyping=false; emitTyping(false); }, 1200);
});

socket.on('typing', ({from,roomId,isTyping})=>{
  if (!activeRoom || activeRoom.id !== roomId) return;
  if (isTyping) typers.add(from); else typers.delete(from);
  updateHeader(); // only updates text if changed
});

function roomBaseTitle(){
  if (!activeRoom) return 'No room selected';
  return `${activeRoom.kind==='dm'?'DM with':'Group'}: ${activeRoom.title}`;
}
let lastHeaderText = '';
function updateHeader(){
  if (!activeRoom){ setHeaderText('No room selected'); return; }
  const suffix = typers.size ? ` • ${[...typers].join(', ')} is typing…` : '';
  setHeaderText(roomBaseTitle() + suffix);
}
function setHeaderText(s){
  if (lastHeaderText !== s) {
    el.roomTitle.textContent = s;
    lastHeaderText = s;
  }
}

// ---------- Receipts (DM) ----------
function newMsgId(){ return `${myName}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }

// ---------- Register ----------
async function promptName(){
  let name='';
  do{
    name = prompt('Choose a unique username');
    if (name===null) return;
    name = (name||'').trim();
    if (!name) continue;
    const res = await emitAck('register', name);
    if (res.ok){ myName = res.me; el.meBox.textContent = `You: ${myName}`; return; }
    else alert(res.error || 'Cannot register');
  } while(true);
}
function ensureRegistered(){ return !!myName; }
function emitAck(event, payload){ return new Promise(resolve=>socket.emit(event, payload, resolve)); }

// ---------- Room & render helpers ----------
function setRoom(roomId, kind, title, history=[]){
  activeRoom = { id:roomId, kind, title };
  messagesByRoom.set(roomId, history);
  typers.clear();
  updateHeader();
  renderMessages(); // initial (full) render only when switching rooms
}

function renderTextMaybeLink(t){
  if (!t) return '';
  const m = t.match(/\((image|file)\)\s+(\/uploads\/\S+)/);
  if (!m) return escapeHtml(t);
  const url = m[2];
  return m[1]==='image' ? `<img src="${url}" style="max-width:240px;border-radius:8px;">`
                        : `<a href="${url}" target="_blank" rel="noopener">Download file</a>`;
}
function escapeHtml(s){ return s.replace(/[&<>"]+/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function msgKey(m){ return m.id || `${m.from}-${m.ts}`; }

function makeMsgNode(m){
  const wrap = document.createElement('div');
  wrap.className = 'msg' + (m.from === myName ? ' me' : '');
  wrap.dataset.id = msgKey(m);
  const tick = (m.from===myName) ? (m.seen ? '✓✓' : (m.delivered ? '✓' : '')) : '';
  wrap.innerHTML = `
    <span class="meta">${new Date(m.ts).toLocaleTimeString()} • ${m.from} <span class="ticks">${tick}</span></span>
    <div class="text">${renderTextMaybeLink(m.text || '')}</div>
  `;
  return wrap;
}

function appendMessageNode(node){
  const nearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 40;
  el.messages.appendChild(node);
  if (nearBottom) el.messages.scrollTop = el.messages.scrollHeight;
}

function renderMessages(){
  const arr = messagesByRoom.get(activeRoom?.id) || [];
  el.messages.innerHTML = '';
  for (const m of arr) appendMessageNode(makeMsgNode(m));
}

function setTickById(id, tickText){
  const node = el.messages.querySelector(`.msg[data-id="${id}"] .ticks`);
  if (node) node.textContent = tickText;
}

// ---------- Users list ----------
socket.on('user_list', (users)=>{
  el.userList.innerHTML='';
  (users||[]).filter(u=>u!==myName).forEach(u=>{
    const li=document.createElement('li');
    const btn=document.createElement('button');
    btn.textContent=u;
    btn.onclick=async()=>{
      if (!ensureRegistered()){ await promptName(); if (!ensureRegistered()) return; }
      const res=await emitAck('open_dm', u);
      if (res.ok) setRoom(res.roomId, 'dm', res.peer, await decodeHistory(res.history));
      else alert(res.error||'Cannot open DM');
    };
    li.appendChild(btn); el.userList.appendChild(li);
  });
});

// ---------- Groups list ----------
socket.on('groups_list', (groups)=>renderGroupList(groups));
function renderGroupList(groups){
  el.groupList.innerHTML='';
  (groups||[]).forEach(g=>{
    const li=document.createElement('li');
    const title=document.createElement('div'); title.className='group-title'; title.textContent=`${g.name} (${g.members.length})`;
    const members=document.createElement('div'); members.className='members'; members.textContent=g.members.join(', ');
    const actions=document.createElement('div'); actions.className='actions';

    const joined = g.members.includes(myName);
    const openBtn=document.createElement('button'); openBtn.textContent='Open'; openBtn.disabled=!joined;
    openBtn.onclick=async()=>{
      if (!ensureRegistered()){ await promptName(); if (!ensureRegistered()) return; }
      const res=await emitAck('join_group', g.name);
      if (res.ok) setRoom(res.roomId, 'group', g.name, await decodeHistory(res.history));
      else alert(res.error||'Cannot open group');
    };
    const joinBtn=document.createElement('button'); joinBtn.textContent=joined?'Joined':'Join'; joinBtn.disabled=joined;
    joinBtn.onclick=async()=>{
      if (!ensureRegistered()){ await promptName(); if (!ensureRegistered()) return; }
      const res=await emitAck('join_group', g.name);
      if (res.ok) setRoom(res.roomId, 'group', g.name, await decodeHistory(res.history));
      else alert(res.error||'Cannot join');
    };

    actions.appendChild(openBtn); actions.appendChild(joinBtn);
    li.appendChild(title); li.appendChild(members); li.appendChild(actions);
    el.groupList.appendChild(li);
  });
}

// ---------- Create group (robust) ----------
el.createGroupBtn.addEventListener('click', async ()=>{
  el.groupError.textContent='';
  if (!ensureRegistered()){ await promptName(); if (!ensureRegistered()) { el.groupError.textContent='Please register first.'; return; } }
  const name = (el.newGroupName.value||'').trim();
  if (!name){ el.groupError.textContent='Enter a group name.'; return; }
  const res = await emitAck('create_group', name);
  if (!res.ok){ el.groupError.textContent = res.error || 'Cannot create group'; return; }
  // auto-open the group after creation
  const join = await emitAck('join_group', name);
  if (join.ok) setRoom(join.roomId, 'group', name, await decodeHistory(join.history));
  el.newGroupName.value='';
});

// ---------- Send message ----------
el.sendForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const text = el.msgInput.value.trim();
  if (!activeRoom || !text) return;
  if (activeRoom.kind==='dm'){
    const id=newMsgId();
    const enc=await encryptText(text);
    const body = enc.clear ? { to:activeRoom.title, text:enc.clear, id } : { to:activeRoom.title, e2ee:true, cipher:enc.cipher, iv:enc.iv, id };
    const res=await emitAck('dm', body);
    if (!res.ok) return alert(res.error||'Failed to send');
  } else {
    const enc2=await encryptText(text);
    const body2 = enc2.clear ? { group:activeRoom.title, text:enc2.clear } : { group:activeRoom.title, e2ee:true, cipher:enc2.cipher, iv:enc2.iv };
    const res2=await emitAck('group_message', body2);
    if (!res2.ok) return alert(res2.error||'Failed to send');
  }
  el.msgInput.value='';
});

// ---------- File upload ----------
el.fileInput.addEventListener('change', async (e)=>{
  if (!activeRoom || !e.target.files.length) return;
  const fd=new FormData(); fd.append('file', e.target.files[0]);
  let data;
  try {
    const resp=await fetch('/upload', { method:'POST', body: fd });
    data = await resp.json();
  } catch {
    alert('Upload failed (network or non-JSON error)'); e.target.value=''; return;
  }
  if (!data.ok) { alert(data.error||'Upload failed'); e.target.value=''; return; }

  const url=data.url; const text = data.mimetype?.startsWith('image/') ? `(image) ${url}` : `(file) ${url}`;
  if (activeRoom.kind==='dm'){
    const id=newMsgId(); const enc=await encryptText(text);
    const body = enc.clear ? { to:activeRoom.title, text:enc.clear, id } : { to:activeRoom.title, e2ee:true, cipher:enc.cipher, iv:enc.iv, id };
    await emitAck('dm', body);
  } else {
    const enc2=await encryptText(text);
    const body2 = enc2.clear ? { group:activeRoom.title, text:enc2.clear } : { group:activeRoom.title, e2ee:true, cipher:enc2.cipher, iv:enc2.iv };
    await emitAck('group_message', body2);
  }
  e.target.value='';
});

// ---------- Incoming messages (append-only) ----------
socket.on('room_message', async (payload)=>{
  const roomId = payload.roomId;
  const arr = messagesByRoom.get(roomId) || [];
  const text = await decryptText(payload);
  const m = { id: payload.id, from: payload.from, text, ts: payload.ts };
  arr.push(m); messagesByRoom.set(roomId, arr);
  if (activeRoom && activeRoom.id===roomId) {
    appendMessageNode(makeMsgNode(m));
    // if DM and it's from peer, mark seen (debounced, no spam)
    if (activeRoom.kind==='dm' && payload.from !== myName) markDmSeen();
  }
});

// ---------- Receipt updates (no full re-render) ----------
socket.on('delivered', ({id})=>{
  if (!id) return;
  // Update state for current room if visible
  if (activeRoom) {
    const arr = messagesByRoom.get(activeRoom.id)||[];
    const m = arr.find(x=>x.id===id);
    if (m && !m.delivered) m.delivered = true;
  }
  setTickById(id, '✓');
});

socket.on('read_dm', ({from,lastId})=>{
  // Mark our sent DM messages up to lastId as seen across all DM rooms
  for (const [roomId, arr] of messagesByRoom) {
    if (!roomId.startsWith('dm:')) continue;
    for (const m of arr) {
      if (m.from === myName && (!lastId || m.id <= lastId)) m.seen = true;
    }
  }
  // Update ticks only in the currently open room (if DM)
  if (activeRoom && activeRoom.id.startsWith('dm:')) {
    const arr = messagesByRoom.get(activeRoom.id) || [];
    for (const m of arr) {
      if (m.from === myName) setTickById(msgKey(m), '✓✓');
    }
  }
});

// ---------- Debounced read receipts (no 2s interval spam) ----------
const lastSeenSentByRoom = new Map();
let readDebounce;
function markDmSeen(){
  if (!activeRoom || activeRoom.kind!=='dm') return;
  const arr = messagesByRoom.get(activeRoom.id)||[];
  const lastFromPeer = [...arr].reverse().find(m=>m.from!==myName);
  if (!lastFromPeer) return;
  const already = lastSeenSentByRoom.get(activeRoom.id);
  if (already === lastFromPeer.id) return; // nothing new to report
  clearTimeout(readDebounce);
  readDebounce = setTimeout(()=>{
    socket.emit('read_dm', { peer: activeRoom.title, lastId: lastFromPeer.id });
    lastSeenSentByRoom.set(activeRoom.id, lastFromPeer.id);
  }, 250);
}
el.messages.addEventListener('scroll', markDmSeen);
window.addEventListener('focus', markDmSeen);
// NOTE: removed setInterval(markDmSeen, 2000);

// ---------- E2EE button ----------
el.e2eeBtn.addEventListener('click', enableE2EEForRoom);

// ---------- History decoder ----------
async function decodeHistory(hist){
  const out=[]; for (const m of (hist||[])){ const text=await decryptText(m); out.push({ id:m.id, from:m.from, text, ts:m.ts }); } return out;
}

// ---------- Init ----------
(async function init(){ await promptName(); })();
