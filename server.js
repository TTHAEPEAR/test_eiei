// server.js (SP2: same server, minor tighten)
try { require('dotenv').config(); } catch (_) {}

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const { Server } = require('socket.io');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, methods: ['GET','POST'] } });

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g,'_'))
});
const upload = multer({ storage, limits: { fileSize: 5*1024*1024 } });
app.post('/upload', upload.single('file'), (req,res)=>{
  if (!req.file) return res.status(400).json({ ok:false, error:'No file' });
  res.json({ ok:true, url: `/uploads/${req.file.filename}`, mimetype:req.file.mimetype, size:req.file.size });
});

const PORT = process.env.PORT || 3000;

// State
const usersBySocket = new Map();
const socketsByUser = new Map();
const groups = new Map();      // groupName -> Set(usernames)
const roomHistory = new Map(); // roomId -> [{...}]

const getUserList = () => Array.from(socketsByUser.keys()).sort((a,b)=>a.localeCompare(b));
const dmRoomId = (a,b)=>`dm:${[a,b].sort().join('|')}`;
const grpRoomId = (n)=>`grp:${n}`;
const appendHistory = (roomId, msg)=>{
  const arr = roomHistory.get(roomId) || [];
  arr.push(msg); if (arr.length>200) arr.shift();
  roomHistory.set(roomId, arr);
};
const emitGroupsList = (to)=>{
  const list = Array.from(groups.entries()).map(([name, members])=>({name, members:[...members].sort()})).sort((a,b)=>a.name.localeCompare(b.name));
  to ? to.emit('groups_list', list) : io.emit('groups_list', list);
};

io.on('connection', (socket)=>{
  socket.on('register', (username, ack)=>{
    username = String(username||'').trim();
    if (!username) return ack?.({ ok:false, error:'Username is required' });
    if (socketsByUser.has(username)) return ack?.({ ok:false, error:'Username already in use' });
    usersBySocket.set(socket.id, username);
    socketsByUser.set(username, socket.id);
    socket.data.username = username;
    io.emit('user_list', getUserList());
    emitGroupsList(socket);
    ack?.({ ok:true, me:username, users:getUserList() });
  });

  socket.on('open_dm', (peer, ack)=>{
    const me = socket.data.username;
    if (!me) return ack?.({ ok:false, error:'Not registered' });
    const peerId = socketsByUser.get(peer);
    if (!peerId) return ack?.({ ok:false, error:'Peer not online' });
    const roomId = dmRoomId(me, peer);
    socket.join(roomId);
    io.sockets.sockets.get(peerId)?.join(roomId);
    ack?.({ ok:true, roomId, kind:'dm', peer, history: roomHistory.get(roomId)||[] });
  });

  socket.on('typing', ({roomId,isTyping})=>{
    const me = socket.data.username; if (!me||!roomId) return;
    socket.to(roomId).emit('typing', { from:me, roomId, isTyping: !!isTyping });
  });

  socket.on('dm', (body, ack)=>{
    const me = socket.data.username;
    if (!me) return ack?.({ ok:false, error:'Not registered' });
    const to = String(body?.to||'').trim();
    const toId = socketsByUser.get(to);
    if (!toId) return ack?.({ ok:false, error:'Recipient not online' });

    const id = body?.id || `${me}-${Date.now()}`;
    const e2ee = !!body?.e2ee;
    const cipher = body?.cipher, iv = body?.iv;
    let text = body?.text;

    if (!e2ee) { text = String(text||'').trim(); if (!text) return ack?.({ ok:false, error:'Empty message' }); }
    else { if (!cipher || !iv) return ack?.({ ok:false, error:'Missing cipher/iv' }); }

    const roomId = dmRoomId(me, to);
    const payload = { id, roomId, kind:'dm', from:me, to, ts: Date.now(), ...(e2ee?{e2ee:true,cipher,iv}:{text}) };
    appendHistory(roomId, { id, from:me, ts: payload.ts, ...(e2ee?{e2ee:true,cipher,iv}:{text}) });
    io.to(roomId).emit('room_message', payload);
    socket.emit('delivered', { id });
    ack?.({ ok:true });
  });

  socket.on('read_dm', ({peer,lastId})=>{
    const me = socket.data.username;
    const pid = socketsByUser.get(peer);
    if (me && pid) io.to(pid).emit('read_dm', { from:me, lastId });
  });

  socket.on('create_group', (groupName, ack)=>{
    const me = socket.data.username;
    if (!me) return ack?.({ ok:false, error:'Not registered' });
    groupName = String(groupName||'').trim();
    if (!groupName) return ack?.({ ok:false, error:'Group name required' });
    if (groups.has(groupName)) return ack?.({ ok:false, error:'Group already exists' });
    groups.set(groupName, new Set([me]));
    socket.join(grpRoomId(groupName));
    emitGroupsList();
    ack?.({ ok:true, group:groupName });
  });

  socket.on('list_groups', (ack)=>{
    const me = socket.data.username;
    if (!me) return ack?.({ ok:false, error:'Not registered' });
    const list = Array.from(groups.entries()).map(([name, members])=>({name, members:[...members].sort()})).sort((a,b)=>a.name.localeCompare(b.name));
    ack?.({ ok:true, groups:list });
  });

  socket.on('join_group', (groupName, ack)=>{
    const me = socket.data.username;
    if (!me) return ack?.({ ok:false, error:'Not registered' });
    const g = groups.get(groupName);
    if (!g) return ack?.({ ok:false, error:'No such group' });
    g.add(me);
    const roomId = grpRoomId(groupName);
    socket.join(roomId);
    emitGroupsList();
    ack?.({ ok:true, group:groupName, roomId, history: roomHistory.get(roomId)||[] });
  });

  socket.on('group_message', (body, ack)=>{
    const me = socket.data.username;
    if (!me) return ack?.({ ok:false, error:'Not registered' });
    const group = String(body?.group||'').trim();
    const g = groups.get(group);
    if (!g) return ack?.({ ok:false, error:'No such group' });
    if (!g.has(me)) return ack?.({ ok:false, error:'Join the group first' });

    const e2ee = !!body?.e2ee;
    const cipher = body?.cipher, iv = body?.iv;
    let text = body?.text;

    if (!e2ee) { text = String(text||'').trim(); if (!text) return ack?.({ ok:false, error:'Empty message' }); }
    else { if (!cipher || !iv) return ack?.({ ok:false, error:'Missing cipher/iv' }); }

    const roomId = grpRoomId(group);
    const payload = { roomId, kind:'group', group, from:me, ts: Date.now(), ...(e2ee?{e2ee:true,cipher,iv}:{text}) };
    appendHistory(roomId, { from:me, ts: payload.ts, ...(e2ee?{e2ee:true,cipher,iv}:{text}) });
    io.to(roomId).emit('room_message', payload);
    ack?.({ ok:true });
  });

  socket.on('disconnect', ()=>{
    const me = usersBySocket.get(socket.id);
    if (me) {
      usersBySocket.delete(socket.id);
      socketsByUser.delete(me);
      io.emit('user_list', getUserList());
    }
  });
});

server.listen(PORT, ()=>console.log(`Server listening on http://localhost:${PORT}`));
