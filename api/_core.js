const crypto = require('crypto');

const STATE_KEY = 'planning-poker:state:v1';
const ACTIVE_MS = 45000;

const ROUND_TYPES = [
  { key: 'knowledge', label: 'How much is known about the task?', icon: '🔍' },
  { key: 'dependencies', label: 'Dependencies', icon: '🔗' },
  { key: 'effort', label: 'How much work effort?', icon: '⚡' },
];

const COLORS = ['#7F77DD','#1D9E75','#D85A30','#D4537E','#378ADD','#639922','#BA7517','#E24B4A','#888780'];

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

function defaultState() {
  return {
    demands: [],
    participants: {},
    currentDemandId: null,
    updatedAt: Date.now(),
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
    const state = {
      demands: Array.isArray(parsed.demands) ? parsed.demands : [],
      participants: parsed.participants && typeof parsed.participants === 'object' ? parsed.participants : {},
      currentDemandId: typeof parsed.currentDemandId === 'string' || parsed.currentDemandId === null ? parsed.currentDemandId : null,
      updatedAt: Number(parsed.updatedAt) || Date.now(),
    };

    return { state, storage: 'kv' };
  } catch {
    return { state: getMemoryState(), storage: 'memory' };
  }
}

async function saveState(state, storage) {
  state.updatedAt = Date.now();

  if (storage === 'kv' && hasKV()) {
    await kvCommand(['SET', STATE_KEY, JSON.stringify(state)]);
    return;
  }

  globalThis.__PLANNING_POKER_MEMORY_STATE__ = state;
}

function ensureParticipant(state, sessionId, name) {
  const safeName = sanitizeName(name);
  let participant = Object.values(state.participants).find(p => p.sessionId === sessionId) || null;

  if (!participant) {
    const participantId = generateId();
    const colorIdx = Object.keys(state.participants).length % COLORS.length;
    participant = {
      id: participantId,
      sessionId,
      name: safeName,
      color: COLORS[colorIdx],
      lastSeen: Date.now(),
      online: true,
    };
    state.participants[participantId] = participant;
  } else {
    participant.name = safeName;
    participant.lastSeen = Date.now();
    participant.online = true;
  }

  return participant;
}

function refreshPresence(state) {
  const now = Date.now();
  for (const participant of Object.values(state.participants)) {
    participant.online = (now - (participant.lastSeen || 0)) <= ACTIVE_MS;
  }
}

function getPublicState(state) {
  refreshPresence(state);

  const currentDemand = state.demands.find(d => d.id === state.currentDemandId) || null;
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

  const participantsPublic = Object.fromEntries(
    Object.entries(state.participants).map(([id, p]) => [id, {
      id: p.id,
      name: p.name,
      color: p.color,
      online: !!p.online,
    }])
  );

  const activeParticipantIds = Object.values(state.participants)
    .filter(p => p.online)
    .map(p => p.id);

  return {
    type: 'state',
    demands: state.demands,
    participants: participantsPublic,
    activeParticipantIds,
    currentDemandId: state.currentDemandId,
    currentDemand,
    roundData,
    roundTypes: ROUND_TYPES,
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

function applyAction(state, participant, action) {
  switch (action.type) {
    case 'ping':
      return;

    case 'add_demand': {
      const title = sanitizeTitle(action.title);
      if (!title) return;
      state.demands.push({
        id: generateId(),
        title,
        status: 'pending',
        currentRound: 0,
        rounds: ROUND_TYPES.map(() => ({ votes: {}, revealed: false })),
        finalScore: null,
      });
      return;
    }

    case 'select_demand': {
      const d = state.demands.find(x => x.id === action.demandId);
      if (!d) return;
      state.currentDemandId = d.id;
      return;
    }

    case 'start_demand': {
      const d = state.demands.find(x => x.id === action.demandId);
      if (!d) return;
      d.status = 'voting';
      d.currentRound = 0;
      d.rounds = ROUND_TYPES.map(() => ({ votes: {}, revealed: false }));
      d.finalScore = null;
      state.currentDemandId = d.id;
      return;
    }

    case 'vote': {
      const d = state.demands.find(x => x.id === state.currentDemandId);
      if (!d || d.status !== 'voting') return;
      const round = d.rounds[d.currentRound];
      if (round.revealed) return;
      round.votes[participant.id] = action.value;
      return;
    }

    case 'reveal': {
      const d = state.demands.find(x => x.id === state.currentDemandId);
      if (!d || d.status !== 'voting') return;
      d.rounds[d.currentRound].revealed = true;
      return;
    }

    case 'next_round': {
      const d = state.demands.find(x => x.id === state.currentDemandId);
      if (!d || d.status !== 'voting') return;
      if (d.currentRound < 2) d.currentRound++;
      return;
    }

    case 'finish_demand': {
      const d = state.demands.find(x => x.id === state.currentDemandId);
      if (!d || d.status !== 'voting') return;
      d.finalScore = computeFinalScore(d);
      d.status = 'done';
      state.currentDemandId = d.id;
      return;
    }

    case 'reset_demand': {
      const d = state.demands.find(x => x.id === action.demandId);
      if (!d) return;
      d.status = 'pending';
      d.currentRound = 0;
      d.rounds = ROUND_TYPES.map(() => ({ votes: {}, revealed: false }));
      d.finalScore = null;
      if (state.currentDemandId === d.id) state.currentDemandId = d.id;
      return;
    }

    case 'delete_demand': {
      state.demands = state.demands.filter(x => x.id !== action.demandId);
      if (state.currentDemandId === action.demandId) {
        state.currentDemandId = state.demands[0]?.id || null;
      }
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
  ensureParticipant,
  getPublicState,
  applyAction,
  readJson,
  getQuery,
  sendJson,
  generateId,
};
