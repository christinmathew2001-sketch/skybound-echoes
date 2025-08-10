// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mime = require('mime');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Serve static files from ./public
app.use(express.static(path.join(__dirname, 'public')));

// Very small health route
app.get('/health', (req, res) => res.send('ok'));

// Game state
let nextId = 1;
const players = new Map(); // id -> { id, name, x,y, bubbleRadius, ws }
let coins = [];
const WORLD_W = 1600, WORLD_H = 900, GROUND_Y = WORLD_H - 120;

// spawn coins deterministically for now
function spawnCoins() {
  coins = [];
  for (let i = 0; i < 20; i++) {
    coins.push({
      id: 'c' + i,
      x: 80 + Math.floor(Math.random() * (WORLD_W - 160)),
      y: 80 + Math.floor(Math.random() * (WORLD_H - 240)),
      taken: false
    });
  }
}
spawnCoins();

// Broadcast authoritative state (players minimal info + coins)
function broadcastState() {
  const payload = {
    type: 'state',
    t: Date.now(),
    players: Array.from(players.values()).map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y, bubbleRadius: p.bubbleRadius
    })),
    coins: coins.map(c => ({ id: c.id, x: c.x, y: c.y, taken: c.taken }))
  };
  const raw = JSON.stringify(payload);
  for (const p of players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
  }
}

// Helper to send to a single client
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// WebSocket handling: messages used:
// - join { name }
// - update { x, y, bubbleRadius }
// - collect { coinId }
// - signal { to, data }   // WebRTC signaling forwarded server->target
wss.on('connection', (ws) => {
  const id = 'p' + (nextId++);
  const player = { id, name: 'Pilot' + id, x: WORLD_W/2, y: WORLD_H/2, bubbleRadius: 120, ws };
  players.set(id, player);

  // send welcome + id and initial world
  send(ws, { type: 'welcome', id, world: { w: WORLD_W, h: WORLD_H, groundY: GROUND_Y }, coins });

  // announce new player (so clients know to connect/signaling)
  broadcastState();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }
    if (!msg || !msg.type) return;

    if (msg.type === 'join') {
      player.name = typeof msg.name === 'string' ? msg.name.slice(0,32) : player.name;
      if (typeof msg.x === 'number') player.x = msg.x;
      if (typeof msg.y === 'number') player.y = msg.y;
      broadcastState();
    }

    if (msg.type === 'update') {
      // position updates from client; basic validation
      if (typeof msg.x === 'number') player.x = Math.max(0, Math.min(WORLD_W, msg.x));
      if (typeof msg.y === 'number') player.y = Math.max(0, Math.min(WORLD_H, msg.y));
      if (typeof msg.bubbleRadius === 'number') player.bubbleRadius = Math.max(30, Math.min(400, msg.bubbleRadius));
      // small immediate broadcast (or rely on periodic)
    }

    if (msg.type === 'collect') {
      const coinId = msg.coinId;
      const coin = coins.find(c => c.id === coinId);
      if (coin && !coin.taken) {
        // basic proximity server-side check
        const dx = coin.x - player.x, dy = coin.y - player.y;
        if (dx*dx + dy*dy < 20*20) {
          coin.taken = true;
          // broadcast state so all clients remove coin
          broadcastState();
        }
      }
    }

    if (msg.type === 'signal') {
      // forwarding signaling to target if present (WebRTC signaling)
      const target = players.get(msg.to);
      if (target && target.ws && target.ws.readyState === WebSocket.OPEN) {
        send(target.ws, { type: 'signal', from: player.id, data: msg.data });
      }
    }

    if (msg.type === 'chat') {
      // optional text chat broadcast
      const text = String(msg.text || '').slice(0, 500);
      broadcastState(); // (we keep simple; you could broadcast chat separately)
    }
  });

  ws.on('close', () => {
    players.delete(id);
    // inform all clients promptly
    broadcastState();
  });
});

// periodic authoritative broadcast (20 Hz)
setInterval(broadcastState, 50);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
