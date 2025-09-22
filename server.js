const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Game } = require('./gameEngine');
const { nanoid } = require('nanoid');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = 3000;

const rooms = {}; // roomId -> Game

function getRoomList() {
  return Object.entries(rooms).map(([roomId, game]) => ({
    roomId,
    players: game.players.length,
  }));
}

function removePlayerFromAllRooms(socketId) {
  for (const roomId in rooms) {
    const g = rooms[roomId];
    const idx = g.players.findIndex(p => p.socketId === socketId);
    if (idx >= 0) {
      g.players.splice(idx, 1);
      io.to(roomId).emit('room_update', { players: g.players.map(p => ({ id: p.id, name: p.name })) });
    }
    if (g.players.length === 0) {
      delete rooms[roomId];
    }
  }
  io.emit('room_list_update', getRoomList());
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('create_room', ({ name }, cb) => {
    let roomId = nanoid(6);
    while (rooms[roomId]) roomId = "r" + Math.random().toString(36).slice(2, 8);

    const g = new Game(roomId);
    rooms[roomId] = g;

    const playerId = "p" + nanoid(5);
    g.addPlayer(playerId, socket.id, name || 'Host');
    socket.join(roomId);

    io.emit('room_list_update', getRoomList());
    io.to(roomId).emit('room_update', { players: g.players.map(p => ({ id: p.id, name: p.name })) });

    cb && cb({ ok: true, roomId, playerId });
  });


  socket.on('join_room', ({ roomId, name }, cb) => {
    const g = rooms[roomId];
    if (!g) return cb && cb({ error: 'no_room' });

    // Игрок с этим socket уже в комнате
    const existing = g.players.find(p => p.socketId === socket.id);
    if (existing) return cb && cb({ ok: true, playerId: existing.id });

    let playerId = "p" + nanoid(5);
    while (g.players.find(p => p.id === playerId)) {
      playerId = "p" + nanoid(5);
    }

    g.addPlayer(playerId, socket.id, name || 'Guest');
    socket.join(roomId);

    // Обновляем комнаты и игроков
    io.to(roomId).emit('room_update', { players: g.players.map(p => ({ id: p.id, name: p.name })) });
    io.emit('room_list_update', getRoomList());

    cb && cb({ ok: true, playerId });
  });

  socket.on('get_rooms', (cb) => {
    cb && cb(getRoomList());
  });


  socket.on('start_game', ({ roomId }, cb) => {
    const g = rooms[roomId];
    if (!g) return cb && cb({ error: 'no_room' });
    
    try {
      g.start();
      // after start, give each player initial hand by replenish (config.fullHandSize)
      g.replenishHands();
      // send state to all
      for (const p of g.players) {
        io.to(p.socketId).emit('game_state', g.publicStateFor(p.id));
      }
      io.to(roomId).emit('room_update', { players: g.players.map(p => ({ id: p.id, name: p.name })) });
      cb && cb({ ok: true });
    } catch (err) {
      cb && cb({ error: err.message });
    }
  });

  socket.on('play_card', ({ roomId, playerId, cardId }, cb) => {
    const g = rooms[roomId];
    if (!g) return cb && cb({ error: 'no_room' });
    try {
      const res = g.playCard(playerId, cardId);
      // broadcast updated state to all players
      for (const p of g.players) io.to(p.socketId).emit('game_state', g.publicStateFor(p.id));
      cb && cb({ ok: true, res });
    } catch (err) {
      cb && cb({ error: err.message });
    }
  });

  socket.on('defend_with', ({ roomId, playerId, cardId }, cb) => {
    const g = rooms[roomId];
    if (!g) return cb && cb({ error: 'no_room' });
    try {
      const res = g.defendWith(playerId, cardId);
      // After defend, check if round closed automatically by logic inside defendWith
      for (const p of g.players) io.to(p.socketId).emit('game_state', g.publicStateFor(p.id));
      cb && cb({ ok: true, res });
    } catch (err) {
      cb && cb({ error: err.message });
    }
  });

  socket.on('take_bottom', ({ roomId, playerId }, cb) => {
    const g = rooms[roomId];
    if (!g) return cb && cb({ error: 'no_room' });
    try {
      const res = g.takeBottom(playerId);
      for (const p of g.players) io.to(p.socketId).emit('game_state', g.publicStateFor(p.id));
      cb && cb({ ok: true, res });
    } catch (err) {
      cb && cb({ error: err.message });
    }
  });

  socket.on('get_state', ({ roomId, playerId }, cb) => {
    const g = rooms[roomId];
    if (!g) return cb && cb({ error: 'no_room' });
    const p = g.players.find(x => x.id === playerId);
    if (!p) return cb && cb({ error: 'not_in_room' });
    io.to(socket.id).emit('game_state', g.publicStateFor(p.id));
    cb && cb({ ok: true });
  });

  socket.on('disconnecting', () => {
    // optional: remove player from rooms they are in
    console.log('socket disconnecting', socket.id);
    removePlayerFromAllRooms(socket.id);
  });
});

app.get('/', (req, res) => res.send('Игровой сервер запущен'));
server.listen(PORT, () => console.log('Сервер запущен на порту', PORT));
