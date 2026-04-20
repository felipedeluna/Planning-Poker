const {
  loadState,
  saveState,
  ensureRoomParticipant,
  findParticipantBySession,
  getPublicState,
  applyRoomAction,
  readJson,
  sendJson,
  generateId,
  createRoom,
  getRoom,
  sanitizeRoomCode,
} = require('./_core');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  const body = await readJson(req);
  const name = String(body.name || '').trim();
  const avatar = String(body.avatar || '').trim() || '🙂';
  if (!name) {
    sendJson(res, 400, { ok: false, error: 'Name is required' });
    return;
  }

  const { state, storage } = await loadState();

  const sessionId = String(body.sessionId || '').trim() || generateId();
  const roomCode = sanitizeRoomCode(body.roomCode);
  let room = getRoom(state, roomCode);
  let participant = room ? findParticipantBySession(room, sessionId) : null;
  let currentRoomCode = room?.code || null;
  let error = null;

  switch (body.type) {
    case 'create_room': {
      room = createRoom(state, sessionId, name, avatar, body.roomName);
      participant = ensureRoomParticipant(room, sessionId, name, avatar);
      currentRoomCode = room.code;
      break;
    }
    case 'join_room': {
      const requestedCode = sanitizeRoomCode(body.targetRoomCode || body.roomCode);
      const targetRoom = getRoom(state, requestedCode);
      if (!targetRoom) {
        error = 'Room not found';
      } else {
        room = targetRoom;
        participant = ensureRoomParticipant(room, sessionId, name, avatar);
        currentRoomCode = room.code;
      }
      break;
    }
    case 'leave_room': {
      if (room && participant) {
        participant.online = false;
        participant.lastSeen = 0;
        for (const demand of room.demands || []) {
          for (const round of demand.rounds || []) {
            if (round.votes && Object.prototype.hasOwnProperty.call(round.votes, participant.id)) {
              delete round.votes[participant.id];
            }
          }
        }
        room.updatedAt = Date.now();
      }
      currentRoomCode = null;
      break;
    }
    default: {
      if (!room) {
        error = 'Room not selected';
      } else if (!participant) {
        currentRoomCode = null;
        error = 'Removed from room';
      } else {
        participant = ensureRoomParticipant(room, sessionId, name, avatar);
        applyRoomAction(room, participant, body);
      }
      break;
    }
  }

  await saveState(state, storage);

  sendJson(res, 200, {
    ok: true,
    state: getPublicState(state, { sessionId, roomCode: currentRoomCode }),
    participantId: participant?.id || null,
    sessionId: participant?.sessionId || sessionId,
    roomCode: currentRoomCode,
    error,
    storage,
  });
};
