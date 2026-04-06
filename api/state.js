const {
  loadState,
  saveState,
  ensureParticipant,
  getPublicState,
  getQuery,
  sendJson,
  generateId,
} = require('./_core');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  const { state, storage } = await loadState();
  const query = getQuery(req);

  const touch = String(query.touch || '') === '1';
  let sessionId = String(query.sessionId || '').trim();
  const name = String(query.name || '').trim();
  let participant = null;

  if (touch && name) {
    if (!sessionId) sessionId = generateId();
    participant = ensureParticipant(state, sessionId, name);
    await saveState(state, storage);
  }

  sendJson(res, 200, {
    ok: true,
    state: getPublicState(state),
    participantId: participant?.id || null,
    sessionId: participant?.sessionId || sessionId || null,
    storage,
  });
};
