const {
  loadState,
  saveState,
  ensureRoomParticipant,
  findParticipantBySession,
  getPublicState,
  getQuery,
  sendJson,
  getRoom,
  sanitizeRoomCode,
} = require('./_core');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  const { state, storage } = await loadState();
  const query = getQuery(req);

  const touch = String(query.touch || '') === '1';
  const roomCode = sanitizeRoomCode(query.roomCode);
  let sessionId = String(query.sessionId || '').trim();
  const name = String(query.name || '').trim();
  const avatar = String(query.avatar || '').trim() || '🙂';
  let participant = null;
  let error = null;

  const room = getRoom(state, roomCode);
  let selectedRoomCode = room?.code || null;
  const existing = room ? findParticipantBySession(room, sessionId) : null;

  if (touch && roomCode && !room) {
    error = 'Room not found';
  } else if (roomCode && room && !existing) {
    error = 'Removed from room';
    selectedRoomCode = null;
  } else if (touch && room && name && existing) {
      participant = ensureRoomParticipant(room, sessionId, name, avatar);
      await saveState(state, storage);
  }

  sendJson(res, 200, {
    ok: true,
    state: getPublicState(state, { sessionId, roomCode: selectedRoomCode }),
    participantId: participant?.id || null,
    sessionId: participant?.sessionId || sessionId || null,
    roomCode: selectedRoomCode,
    error,
    storage,
  });
};
