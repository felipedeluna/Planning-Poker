const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3000;
const STATE_FILE = path.join(__dirname, 'state.json');

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  demands: [],           // { id, title, status: 'pending'|'voting'|'done', currentRound, rounds: [{type,votes:{},revealed}], finalScore }
  participants: {},      // participantId → { id, name, color, sessionId, online, lastSeen }
  currentDemandId: null,
};

let persistTimer = null;

const ROUND_TYPES = [
  { key: 'knowledge',  label: 'How much is known about the task?', icon: '🔍' },
  { key: 'dependencies', label: 'Dependencies',                   icon: '🔗' },
  { key: 'effort',    label: 'How much work effort?',             icon: '⚡' },
];

const COLORS = ['#7F77DD','#1D9E75','#D85A30','#D4537E','#378ADD','#639922','#BA7517','#E24B4A','#888780'];

// ─── WebSocket helpers ────────────────────────────────────────────────────────
const clients = new Map(); // id → { socket, participantId }

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

function sanitizeName(name) {
  const n = String(name || '').trim();
  return n || 'Anonymous';
}

function getOnlineParticipantIds() {
  return Object.values(state.participants)
    .filter(p => p.online)
    .map(p => p.id);
}

function hydrateStateFromDisk() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    if (!raw) return;
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed.demands)) {
      state.demands = parsed.demands;
    }

    if (typeof parsed.currentDemandId === 'string' || parsed.currentDemandId === null) {
      state.currentDemandId = parsed.currentDemandId;
    }
  } catch (err) {
    console.error('Failed to load persisted state:', err.message);
  }
}

function schedulePersistState() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const payload = {
      demands: state.demands,
      currentDemandId: state.currentDemandId,
      updatedAt: Date.now(),
    };

    const tmpFile = `${STATE_FILE}.tmp`;
    fs.writeFile(tmpFile, JSON.stringify(payload, null, 2), 'utf8', err => {
      if (err) {
        console.error('Failed to write state file:', err.message);
        return;
      }
      fs.rename(tmpFile, STATE_FILE, renameErr => {
        if (renameErr) console.error('Failed to finalize state file:', renameErr.message);
      });
    });
  }, 80);
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const [, client] of clients) {
    if (client.socket && !client.socket.destroyed && client.socket.writable) {
      client.socket.write(encodeWsFrame(msg));
    }
  }
}

function sendTo(clientId, data) {
  const client = clients.get(clientId);
  if (client && client.socket && !client.socket.destroyed && client.socket.writable) {
    client.socket.write(encodeWsFrame(JSON.stringify(data)));
  }
}

function encodeWsFrame(data) {
  const payload = Buffer.from(data, 'utf8');
  const len = payload.length;
  let frame;
  if (len < 126) {
    frame = Buffer.allocUnsafe(2 + len);
    frame[0] = 0x81;
    frame[1] = len;
    payload.copy(frame, 2);
  } else if (len < 65536) {
    frame = Buffer.allocUnsafe(4 + len);
    frame[0] = 0x81;
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
    payload.copy(frame, 4);
  } else {
    frame = Buffer.allocUnsafe(10 + len);
    frame[0] = 0x81;
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    payload.copy(frame, 10);
  }
  return frame;
}

function decodeWsFrame(buffer) {
  if (buffer.length < 2) return null;
  const masked = (buffer[1] & 0x80) !== 0;
  let len = buffer[1] & 0x7f;
  let offset = 2;
  if (len === 126) { len = buffer.readUInt16BE(2); offset = 4; }
  else if (len === 127) { len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
  if (buffer.length < offset + (masked ? 4 : 0) + len) return null;
  let payload;
  if (masked) {
    const mask = buffer.slice(offset, offset + 4);
    offset += 4;
    payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = buffer[offset + i] ^ mask[i % 4];
  } else {
    payload = buffer.slice(offset, offset + len);
  }
  return payload.toString('utf8');
}

function handleHandshake(socket, req) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

// ─── Game logic ───────────────────────────────────────────────────────────────
function getPublicState() {
  const demand = state.demands.find(d => d.id === state.currentDemandId) || null;
  const participantsPublic = Object.fromEntries(
    Object.entries(state.participants).map(([id, p]) => [id, {
      id: p.id,
      name: p.name,
      color: p.color,
      online: !!p.online,
    }])
  );
  const activeParticipantIds = getOnlineParticipantIds();
  let roundData = null;
  if (demand && demand.status === 'voting' && demand.currentRound < 3) {
    const r = demand.rounds[demand.currentRound];
    const revealed = r.revealed;
    roundData = {
      index: demand.currentRound,
      ...ROUND_TYPES[demand.currentRound],
      votes: revealed ? r.votes : Object.fromEntries(Object.keys(r.votes).map(k => [k, '?'])),
      revealed,
      voterIds: Object.keys(r.votes),
    };
  }
  return {
    type: 'state',
    demands: state.demands,
    participants: participantsPublic,
    activeParticipantIds,
    currentDemandId: state.currentDemandId,
    currentDemand: demand,
    roundData,
    roundTypes: ROUND_TYPES,
  };
}

function handleMessage(clientId, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const client = clients.get(clientId);

  switch (msg.type) {
    case 'ping': {
      sendTo(clientId, { type: 'pong', ts: Date.now() });
      break;
    }
    case 'join': {
      const name = sanitizeName(msg.name);
      const requestedSessionId = typeof msg.sessionId === 'string' && msg.sessionId.trim()
        ? msg.sessionId.trim()
        : null;

      let participant = null;
      if (requestedSessionId) {
        participant = Object.values(state.participants).find(p => p.sessionId === requestedSessionId) || null;
      }

      if (!participant) {
        const colorIdx = Object.keys(state.participants).length % COLORS.length;
        const participantId = generateId();
        participant = {
          id: participantId,
          name,
          color: COLORS[colorIdx],
          sessionId: requestedSessionId || generateId(),
          online: true,
          lastSeen: Date.now(),
        };
        state.participants[participantId] = participant;
      } else {
        participant.name = name;
        participant.online = true;
        participant.lastSeen = Date.now();
      }

      for (const [otherClientId, otherClient] of clients) {
        if (otherClientId !== clientId && otherClient.participantId === participant.id) {
          try { otherClient.socket.end(); } catch {}
          clients.delete(otherClientId);
        }
      }

      client.participantId = participant.id;
      sendTo(clientId, { type: 'join_ack', participantId: participant.id, sessionId: participant.sessionId });
      broadcast(getPublicState());
      break;
    }
    case 'add_demand': {
      const demand = {
        id: generateId(),
        title: msg.title,
        status: 'pending',
        currentRound: 0,
        rounds: ROUND_TYPES.map(() => ({ votes: {}, revealed: false })),
        finalScore: null,
      };
      state.demands.push(demand);
      schedulePersistState();
      broadcast(getPublicState());
      break;
    }
    case 'start_demand': {
      const d = state.demands.find(x => x.id === msg.demandId);
      if (!d) break;
      d.status = 'voting';
      d.currentRound = 0;
      d.rounds = ROUND_TYPES.map(() => ({ votes: {}, revealed: false }));
      state.currentDemandId = d.id;
      schedulePersistState();
      broadcast(getPublicState());
      break;
    }
    case 'select_demand': {
      const d = state.demands.find(x => x.id === msg.demandId);
      if (!d) break;
      state.currentDemandId = d.id;
      schedulePersistState();
      broadcast(getPublicState());
      break;
    }
    case 'vote': {
      const d = state.demands.find(x => x.id === state.currentDemandId);
      if (!d || d.status !== 'voting') break;
      if (!client?.participantId) break;
      const round = d.rounds[d.currentRound];
      if (round.revealed) break;
      round.votes[client.participantId] = msg.value;
      schedulePersistState();
      broadcast(getPublicState());
      break;
    }
    case 'reveal': {
      const d = state.demands.find(x => x.id === state.currentDemandId);
      if (!d) break;
      d.rounds[d.currentRound].revealed = true;
      schedulePersistState();
      broadcast(getPublicState());
      break;
    }
    case 'next_round': {
      const d = state.demands.find(x => x.id === state.currentDemandId);
      if (!d) break;
      if (d.currentRound < 2) {
        d.currentRound++;
        schedulePersistState();
        broadcast(getPublicState());
      }
      break;
    }
    case 'finish_demand': {
      const d = state.demands.find(x => x.id === state.currentDemandId);
      if (!d) break;
      // compute final score: average of round averages
      const roundAvgs = d.rounds.map(r => {
        const vals = Object.values(r.votes).map(Number).filter(n => !isNaN(n));
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      });
      d.finalScore = Math.round(roundAvgs.reduce((a, b) => a + b, 0) / roundAvgs.length);
      d.status = 'done';
      state.currentDemandId = d.id;
      schedulePersistState();
      broadcast(getPublicState());
      break;
    }
    case 'reset_demand': {
      const d = state.demands.find(x => x.id === msg.demandId);
      if (!d) break;
      d.status = 'pending';
      d.currentRound = 0;
      d.rounds = ROUND_TYPES.map(() => ({ votes: {}, revealed: false }));
      d.finalScore = null;
      if (state.currentDemandId === d.id) state.currentDemandId = null;
      schedulePersistState();
      broadcast(getPublicState());
      break;
    }
    case 'delete_demand': {
      state.demands = state.demands.filter(x => x.id !== msg.demandId);
      if (state.currentDemandId === msg.demandId) state.currentDemandId = null;
      schedulePersistState();
      broadcast(getPublicState());
      break;
    }
  }
}

// ─── HTTP + WS Server ─────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  handleHandshake(socket, req);
  socket.setNoDelay(true);
  const clientId = generateId();
  let buf = Buffer.alloc(0);

  clients.set(clientId, { socket, participantId: null });
  console.log(`Client connected: ${clientId} (total: ${clients.size})`);

  // Send current state immediately
  socket.write(encodeWsFrame(JSON.stringify(getPublicState())));

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      if (opcode === 8) { socket.end(); break; } // close frame
      const raw = decodeWsFrame(buf);
      if (raw === null) break;
      // advance buffer — recalculate consumed bytes
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); offset = 10; }
      if (masked) offset += 4;
      buf = buf.slice(offset + len);
      handleMessage(clientId, raw);
    }
  });

  socket.on('close', () => {
    const client = clients.get(clientId);
    clients.delete(clientId);
    if (client?.participantId && state.participants[client.participantId]) {
      state.participants[client.participantId].online = false;
      state.participants[client.participantId].lastSeen = Date.now();
    }
    console.log(`Client disconnected: ${clientId} (total: ${clients.size})`);
    broadcast(getPublicState());
  });

  socket.on('error', () => {
    const client = clients.get(clientId);
    clients.delete(clientId);
    if (client?.participantId && state.participants[client.participantId]) {
      state.participants[client.participantId].online = false;
      state.participants[client.participantId].lastSeen = Date.now();
    }
    broadcast(getPublicState());
  });
});

hydrateStateFromDisk();

server.listen(PORT, () => {
  console.log(`\n🃏 Planning Poker running at http://localhost:${PORT}\n`);
});
