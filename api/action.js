const {
  loadState,
  saveState,
  ensureParticipant,
  getPublicState,
  applyAction,
  readJson,
  sendJson,
  generateId,
} = require('./_core');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  const body = await readJson(req);
  const name = String(body.name || '').trim();
  if (!name) {
    sendJson(res, 400, { ok: false, error: 'Name is required' });
    return;
  }

  const { state, storage } = await loadState();

  const sessionId = String(body.sessionId || '').trim() || generateId();
  const participant = ensureParticipant(state, sessionId, name);

  applyAction(state, participant, body);
  await saveState(state, storage);

  sendJson(res, 200, {
    ok: true,
    state: getPublicState(state),
    participantId: participant.id,
    sessionId: participant.sessionId,
    storage,
  });
};
