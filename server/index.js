/**
 * 反應擂台 — Express + Socket.IO server
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager, MAX_PLAYERS, MIN_PLAYERS } = require('./game');

const PORT = process.env.PORT || 3100;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, name: 'reaction-arena', players: 'reaction-tap' })
);

const rooms = new RoomManager();

function emitRoom(room) {
  if (!room) return;
  for (const [sid] of room.players) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.emit('room:state', room.publicState(sid));
  }
  io.to(room.code).emit('room:state:public', room.publicState(null));
}

function tryMatchmaking() {
  let result;
  while ((result = rooms.tryMatchmake())) {
    const { room, members } = result;
    for (const m of members) {
      const sock = io.sockets.sockets.get(m.socketId);
      if (sock) {
        sock.join(room.code);
        sock.emit('match:found', { code: room.code, state: room.publicState(m.socketId) });
      }
    }
    emitRoom(room);
    // Auto-start shortly after match
    setTimeout(() => {
      if (room.phase !== 'lobby' || room.ended) return;
      const hostId = room.hostId;
      if (!hostId) return;
      const res = room.startGame(hostId);
      emitRoom(room);
      if (res && res.ok) {
        // countdown already started inside startGame
      }
    }, 800);
    rooms.matchQueue.forEach((q, i) => {
      const sock = io.sockets.sockets.get(q.socketId);
      if (sock) sock.emit('match:waiting', { position: i + 1, waiting: rooms.matchQueue.length });
    });
  }
}

io.on('connection', (socket) => {
  socket.emit('hello', { maxPlayers: MAX_PLAYERS, minPlayers: MIN_PLAYERS });

  socket.on('room:create', (payload = {}, cb) => {
    rooms.leaveMatchQueue(socket.id);
    const nickname = (payload.nickname || 'Player').slice(0, 16);
    const settings = payload.settings || {};
    const room = rooms.create(socket.id, nickname, settings);
    room.mode = 'players';
    socket.join(room.code);
    emitRoom(room);
    if (typeof cb === 'function') cb({ ok: true, code: room.code, state: room.publicState(socket.id) });
  });

  socket.on('room:join', (payload = {}, cb) => {
    rooms.leaveMatchQueue(socket.id);
    const nickname = (payload.nickname || 'Player').slice(0, 16);
    const code = (payload.code || '').toUpperCase().trim();
    const res = rooms.join(code, socket.id, nickname);
    if (!res.ok) {
      if (typeof cb === 'function') cb(res);
      return;
    }
    socket.join(res.room.code);
    emitRoom(res.room);
    if (typeof cb === 'function') cb({ ok: true, code: res.room.code, state: res.room.publicState(socket.id) });
  });

  socket.on('room:settings', (partial = {}) => {
    const room = rooms.getBySocket(socket.id);
    if (!room) return;
    room.updateSettings(socket.id, partial);
    emitRoom(room);
  });

  socket.on('room:ready', (ready) => {
    const room = rooms.getBySocket(socket.id);
    if (!room) return;
    room.setReady(socket.id, ready);
    emitRoom(room);
  });

  socket.on('room:leave', (cb) => {
    rooms.leaveMatchQueue(socket.id);
    const room = rooms.leave(socket.id);
    socket.rooms.forEach((r) => {
      if (r !== socket.id) socket.leave(r);
    });
    if (room) emitRoom(room);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('match:queue', (payload = {}, cb) => {
    const nickname = (payload.nickname || 'Player').slice(0, 16);
    const seats = Math.min(8, Math.max(2, +(payload.seats || 2)));
    const res = rooms.enqueueMatch(socket.id, nickname, seats);
    if (typeof cb === 'function') cb(res);
    if (res.ok) {
      socket.emit('match:waiting', { position: res.position, waiting: res.waiting, seats });
      tryMatchmaking();
    }
  });

  socket.on('match:cancel', (cb) => {
    rooms.leaveMatchQueue(socket.id);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('game:start', (payload, cb) => {
    if (typeof payload === 'function') { cb = payload; payload = {}; }
    const room = rooms.getBySocket(socket.id);
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'no_room' });
      return;
    }
    const res = room.startGame(socket.id);
    emitRoom(room);
    if (typeof cb === 'function') cb(res);
  });

  socket.on('game:tap', (payload = {}, cb) => {
    const room = rooms.getBySocket(socket.id);
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'no_room' });
      return;
    }
    const optionId = payload.optionId;
    const res = room.submitTap(socket.id, optionId);
    emitRoom(room);
    if (room.phase === 'ended') {
      io.to(room.code).emit('game:podium', { podium: room.podium(), code: room.code });
    }
    if (typeof cb === 'function') cb(res);
  });

  socket.on('game:end', (payload, cb) => {
    if (typeof payload === 'function') { cb = payload; payload = {}; }
    const room = rooms.getBySocket(socket.id);
    if (!room) return;
    const res = room.hostEnd(socket.id);
    if (res.ok) {
      emitRoom(room);
      io.to(room.code).emit('game:podium', { podium: res.podium, code: room.code });
    }
    if (typeof cb === 'function') cb(res);
  });

  socket.on('disconnect', () => {
    rooms.leaveMatchQueue(socket.id);
    const room = rooms.leave(socket.id);
    if (room) {
      emitRoom(room);
      const humans = [...room.players.values()].filter((p) => !p.isBot);
      if (humans.length === 0) rooms.rooms.delete(room.code);
    }
  });
});

// Phase timers
setInterval(() => {
  for (const room of rooms.rooms.values()) {
    if (room.phase === 'ended' || room.phase === 'lobby') continue;

    if (room.phase === 'countdown') {
      if (room.beginPlaying()) {
        emitRoom(room);
      }
      continue;
    }

    if (room.phase === 'playing') {
      if (room.maybeTimeoutPlaying()) {
        emitRoom(room);
        if (room.phase === 'ended') {
          io.to(room.code).emit('game:podium', { podium: room.podium(), code: room.code });
        }
      }
      continue;
    }

    if (room.phase === 'result') {
      if (room.advanceAfterResult()) {
        emitRoom(room);
        if (room.phase === 'ended') {
          io.to(room.code).emit('game:podium', { podium: room.podium(), code: room.code });
        }
      }
      continue;
    }

    if (room.phase === 'between') {
      if (room.advanceAfterBetween()) {
        emitRoom(room);
      }
      continue;
    }
  }
  tryMatchmaking();
}, 100);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`反應擂台 listening on http://0.0.0.0:${PORT}`);
});

module.exports = { app, server, rooms, PORT };
