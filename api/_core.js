const crypto = require('crypto');

const STATE_KEY = 'planning-poker:state:v2';
const ACTIVE_MS = 45000;

const ROUND_TYPES = [
  { key: 'knowledge', label: 'How much is known about the task?', icon: '🔍' },
  { key: 'dependencies', label: 'Dependencies', icon: '🔗' },
  { key: 'effort', label: 'How much work effort?', icon: '⚡' },
];

const COLORS = ['#7F77DD', '#1D9E75', '#D85A30', '#D4537E', '#378ADD', '#639922', '#BA7517', '#E24B4A', '#888780'];

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

function sanitizeName(name) {
  const n = String(name || '').trim();
  return n || 'Anonymous';
}

function sanitizeTitle(title) {
  return String(title || '').trim().slice(0, 80);
}

function sanitizeRoomName(name) {
  return String(name || '').trim().slice(0, 40) || 'Planning Room';
}

function sanitizeRoomCode(code) {
  return String(code || '').replace(/\D/g, '').slice(0, 4);
}

function now() {
  return Date.now();
}

function defaultState() {
  return {
    rooms: {},
    updatedAt: now(),
  };
}

function hasKV() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function kvCommand(command) {
  const res = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });

  if (!res.ok) {
    throw new Error(`KV request failed: ${res.status}`);
  }

  const data = await res.json();
  return data.result;
}

function getMemoryState() {
  if (!globalThis.__PLANNING_POKER_MEMORY_STATE__) {
    globalThis.__PLANNING_POKER_MEMORY_STATE__ = defaultState();
  }
  return globalThis.__PLANNING_POKER_MEMORY_STATE__;
}

function migrateLegacyState(parsed) {
  if (parsed && parsed.rooms && typeof parsed.rooms === 'object') {
    return {
      rooms: parsed.rooms,
      updatedAt: Number(parsed.updatedAt) || now(),
    };
  }

  if (!parsed || !Array.isArray(parsed.demands)) {
    return defaultState();
  }

  const code = '0001';
  const participants = parsed.participants && typeof parsed.participants === 'object' ? parsed.participants : {};
  const migratedParticipants = Object.fromEntries(
    Object.entries(participants).map(([id, p]) => [id, {
      id,
      sessionId: p?.sessionId || `legacy-${id}`,
      name: sanitizeName(p?.name),
      color: p?.color || COLORS[Object.keys(participants).indexOf(id) % COLORS.length],
      role: 'member',
      lastSeen: now(),
      online: false,
    }])
  );

  return {
    rooms: {
      [code]: {
        code,
        name: 'Legacy Room',
        ownerSessionId: 'legacy-owner',
        createdAt: now(),
        updatedAt: now(),
        demands: parsed.demands,
        participants: migratedParticipants,
        currentDemandId: parsed.currentDemandId || null,
      },
    },
    updatedAt: now(),
  };
}

async function loadState() {
  if (!hasKV()) {
    return { state: getMemoryState(), storage: 'memory' };
  }

  try {
    const raw = await kvCommand(['GET', STATE_KEY]);
    if (!raw) {
      const state = defaultState();
      await kvCommand(['SET', STATE_KEY, JSON.stringify(state)]);
      return { state, storage: 'kv' };
    }

    const parsed = JSON.parse(raw);
    return { state: migrateLegacyState(parsed), storage: 'kv' };
  } catch {
    return { state: getMemoryState(), storage: 'memory' };
  }
}

async function saveState(state, storage) {
  state.updatedAt = now();

  if (storage === 'kv' && hasKV()) {
    await kvCommand(['SET', STATE_KEY, JSON.stringify(state)]);
    return;
  }

  globalThis.__PLANNING_POKER_MEMORY_STATE__ = state;
}

function createRoom(state, ownerSessionId, ownerName, roomName) {
  const code = generateRoomCode(state);
  const room = {
    code,
    name: sanitizeRoomName(roomName),
    ownerSessionId,
    createdAt: now(),
    updatedAt: now(),
    demands: [],
    participants: {},
    currentDemandId: null,
  };
  state.rooms[code] = room;
  const owner = ensureRoomParticipant(room, ownerSessionId, ownerName);
  owner.role = 'owner';
  return room;
}

function generateRoomCode(state) {
  for (let i = 0; i < 100; i++) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    if (!state.rooms[code]) return code;
  }
  throw new Error('Unable to generate room code');
}

function getRoom(state, roomCode) {
  const code = sanitizeRoomCode(roomCode);
  if (!code) return null;
  return state.rooms[code] || null;
}

function ensureRoomParticipant(room, sessionId, name) {
  const safeName = sanitizeName(name);
  let participant = Object.values(room.participants).find(p => p.sessionId === sessionId) || null;

  if (!participant) {
    const participantId = generateId();
    const colorIdx = Object.keys(room.participants).length % COLORS.length;
    participant = {
      id: participantId,
      sessionId,
      name: safeName,
      color: COLORS[colorIdx],
      role: sessionId === room.ownerSessionId ? 'owner' : 'member',
      lastSeen: now(),
      online: true,
    };
    room.participants[participantId] = participant;
  } else {
    participant.name = safeName;
    participant.lastSeen = now();
    participant.online = true;
    if (participant.sessionId === room.ownerSessionId) participant.role = 'owner';
  }

  return participant;
}

function refreshPresence(room) {
  const ts = now();
  for (const participant of Object.values(room.participants)) {
    participant.online = (ts - (participant.lastSeen || 0)) <= ACTIVE_MS;
  }
}

function getOwnedRooms(state, sessionId) {
  return Object.values(state.rooms)
    .filter(room => room.ownerSessionId === sessionId)
    .map(room => ({
      code: room.code,
      name: room.name,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      totalDemands: room.demands.length,
      doneDemands: room.demands.filter(d => d.status === 'done').length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function canManageRoom(participant) {
  return !!participant && (participant.role === 'owner' || participant.role === 'admin');
}

function canManageRoles(participant) {
  return !!participant && participant.role === 'owner';
}

function buildRoomState(room) {
  refreshPresence(room);

  const currentDemand = room.demands.find(d => d.id === room.currentDemandId) || null;
  let roundData = null;

  if (currentDemand && currentDemand.status === 'voting' && currentDemand.currentRound < 3) {
    const r = currentDemand.rounds[currentDemand.currentRound];
    const revealed = r.revealed;
    roundData = {
      index: currentDemand.currentRound,
      ...ROUND_TYPES[currentDemand.currentRound],
      votes: revealed ? r.votes : Object.fromEntries(Object.keys(r.votes).map(k => [k, '?'])),
      revealed,
      voterIds: Object.keys(r.votes),
    };
  }

  const participants = Object.fromEntries(
    Object.entries(room.participants).map(([id, p]) => [id, {
      id: p.id,
      name: p.name,
      color: p.color,
      role: p.role,
      online: !!p.online,
    }])
  );

  const activeParticipantIds = Object.values(room.participants)
    .filter(p => p.online)
    .map(p => p.id);

  return {
    demands: room.demands,
    participants,
    activeParticipantIds,
    currentDemandId: room.currentDemandId,
    currentDemand,
    roundData,
  };
}

function getPublicState(state, { sessionId, roomCode } = {}) {
  const ownedRooms = sessionId ? getOwnedRooms(state, sessionId) : [];
  const room = getRoom(state, roomCode);
  const roomState = room ? buildRoomState(room) : {
    demands: [],
    participants: {},
    activeParticipantIds: [],
    currentDemandId: null,
    currentDemand: null,
    roundData: null,
  };

  const me = room ? Object.values(room.participants).find(p => p.sessionId === sessionId) || null : null;

  return {
    type: 'state',
    roomCode: room?.code || null,
    roomName: room?.name || null,
    demands: roomState.demands,
    participants: roomState.participants,
    activeParticipantIds: roomState.activeParticipantIds,
    currentDemandId: roomState.currentDemandId,
    currentDemand: roomState.currentDemand,
    roundData: roomState.roundData,
    roundTypes: ROUND_TYPES,
    ownedRooms,
    myRole: me?.role || null,
    canManageRoom: canManageRoom(me),
    canManageRoles: canManageRoles(me),
    updatedAt: state.updatedAt,
  };
}

function computeFinalScore(demand) {
  const roundAvgs = demand.rounds.map(r => {
    const vals = Object.values(r.votes).map(Number).filter(n => !Number.isNaN(n));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  });
  return Math.round(roundAvgs.reduce((a, b) => a + b, 0) / roundAvgs.length);
}

function removeParticipantVotes(room, participantId) {
  for (const demand of room.demands) {
    for (const round of demand.rounds || []) {
      if (round.votes && Object.prototype.hasOwnProperty.call(round.votes, participantId)) {
        delete round.votes[participantId];
      }
    }
  }
}

function applyRoomAction(room, participant, action) {
  switch (action.type) {
    case 'ping':
      return;

    case 'add_demand': {
      const title = sanitizeTitle(action.title);
      if (!title) return;
      room.demands.push({
        id: generateId(),
        title,
        status: 'pending',
        currentRound: 0,
        rounds: ROUND_TYPES.map(() => ({ votes: {}, revealed: false })),
        finalScore: null,
      });
      room.updatedAt = now();
      return;
    }

    case 'select_demand': {
      if (!canManageRoom(participant)) return;
      const d = room.demands.find(x => x.id === action.demandId);
      if (!d) return;
      room.currentDemandId = d.id;
      room.updatedAt = now();
      return;
    }

    case 'start_demand': {
      if (!canManageRoom(participant)) return;
      const d = room.demands.find(x => x.id === action.demandId);
      if (!d) return;
      d.status = 'voting';
      d.currentRound = 0;
      d.rounds = ROUND_TYPES.map(() => ({ votes: {}, revealed: false }));
      d.finalScore = null;
      room.currentDemandId = d.id;
      room.updatedAt = now();
      return;
    }

    case 'vote': {
      const d = room.demands.find(x => x.id === room.currentDemandId);
      if (!d || d.status !== 'voting') return;
      const round = d.rounds[d.currentRound];
      if (round.revealed) return;
      round.votes[participant.id] = action.value;
      room.updatedAt = now();
      return;
    }

    case 'reveal': {
      if (!canManageRoom(participant)) return;
      const d = room.demands.find(x => x.id === room.currentDemandId);
      if (!d || d.status !== 'voting') return;
      d.rounds[d.currentRound].revealed = true;
      room.updatedAt = now();
      return;
    }

    case 'next_round': {
      if (!canManageRoom(participant)) return;
      const d = room.demands.find(x => x.id === room.currentDemandId);
      if (!d || d.status !== 'voting') return;
      if (d.currentRound < 2) d.currentRound++;
      room.updatedAt = now();
      return;
    }

    case 'finish_demand': {
      if (!canManageRoom(participant)) return;
      const d = room.demands.find(x => x.id === room.currentDemandId);
      if (!d || d.status !== 'voting') return;
      d.finalScore = computeFinalScore(d);
      d.status = 'done';
      room.currentDemandId = d.id;
      room.updatedAt = now();
      return;
    }

    case 'reset_demand': {
      if (!canManageRoom(participant)) return;
      const d = room.demands.find(x => x.id === action.demandId);
      if (!d) return;
      d.status = 'pending';
      d.currentRound = 0;
      d.rounds = ROUND_TYPES.map(() => ({ votes: {}, revealed: false }));
      d.finalScore = null;
      room.currentDemandId = d.id;
      room.updatedAt = now();
      return;
    }

    case 'delete_demand': {
      if (!canManageRoom(participant)) return;
      room.demands = room.demands.filter(x => x.id !== action.demandId);
      if (room.currentDemandId === action.demandId) {
        room.currentDemandId = room.demands[0]?.id || null;
      }
      room.updatedAt = now();
      return;
    }

    case 'set_role': {
      if (!canManageRoles(participant)) return;
      const target = room.participants[action.targetParticipantId];
      const role = action.role === 'admin' ? 'admin' : 'member';
      if (!target || target.role === 'owner') return;
      target.role = role;
      room.updatedAt = now();
      return;
    }

    case 'kick_member': {
      if (!canManageRoom(participant)) return;
      const target = room.participants[action.targetParticipantId];
      if (!target || target.role === 'owner') return;
      delete room.participants[action.targetParticipantId];
      removeParticipantVotes(room, action.targetParticipantId);
      room.updatedAt = now();
      return;
    }

    default:
      return;
  }
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getQuery(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

module.exports = {
  loadState,
  saveState,
  createRoom,
  getRoom,
  ensureRoomParticipant,
  getPublicState,
  applyRoomAction,
  readJson,
  getQuery,
  sendJson,
  generateId,
  sanitizeRoomCode,
};
