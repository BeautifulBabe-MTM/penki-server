// server.js
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Game } = require('./gameEngine');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = 3000;

const rooms = {}; // roomId -> Game

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('create_room', ({ roomId, playerId, name }, cb) => {
    if (rooms[roomId]) return cb && cb({ error: 'room_exists' });
    const g = new Game(roomId);
    rooms[roomId] = g;
    g.addPlayer(playerId, socket.id, name || 'Player');
    socket.join(roomId);
    cb && cb({ ok: true });
    io.to(roomId).emit('room_update', { players: g.players.map(p => ({ id:p.id, name:p.name })) });
  });

  socket.on('join_room', ({ roomId, playerId, name }, cb) => {
    const g = rooms[roomId];
    if (!g) return cb && cb({ error: 'no_room' });
    g.addPlayer(playerId, socket.id, name || 'Player');
    socket.join(roomId);
    cb && cb({ ok: true });
    io.to(roomId).emit('room_update', { players: g.players.map(p => ({ id:p.id, name:p.name })) });
  });

  socket.on('start_game', ({ roomId }, cb) => {
    const g = rooms[roomId];
    if (!g) return cb && cb({ error: 'no_room' });
    try {
      g.start();
      // after start, give each player initial hand by replenish (config.fullHandSize)
      g.replenishHands();
      // send state to all
      for (const p of g.players){
        io.to(p.socketId).emit('game_state', g.publicStateFor(p.id));
      }
      io.to(roomId).emit('room_update', { players: g.players.map(p => ({ id:p.id, name:p.name })) });
      cb && cb({ ok: true });
    } catch (err){
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
    } catch (err){
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
    } catch (err){
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
    } catch (err){
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
    for (const rid of socket.rooms) {
      if (rooms[rid]) {
        const g = rooms[rid];
        g.removePlayerBySocket(socket.id);
        io.to(rid).emit('room_update', { players: g.players.map(p => ({ id:p.id, name:p.name })) });
      }
    }
  });
});

app.get('/', (req, res) => res.send('Игровой сервер запущен'));
server.listen(PORT, ()=> console.log('Сервер запущен на порту', PORT));
