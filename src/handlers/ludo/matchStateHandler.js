const withAuth = require('../../middleware/withAuth');
const { redis: redisClient } = require('../../utils/redis');
const { fetchMatchOrEmitError, validateRequiredFields, emitStandardError } = require('../../utils/gameUtils');

const EVENTS = {
  REQUEST: 'get:match_state',
  RESPONSE: 'get:match_state:response'
};

function normalizeId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function sameId(a, b) {
  const na = normalizeId(a);
  const nb = normalizeId(b);
  if (!na || !nb) return false;
  return na === nb;
}

function buildMatchStateResponse(match, userId) {
  return {
    status: 'success',
    game_id: normalizeId(match?.game_id || ''),
    user_id: normalizeId(userId),
    match_state: {
      game_id: normalizeId(match?.game_id || ''),
      user1_id: normalizeId(match?.user1_id || ''),
      user2_id: normalizeId(match?.user2_id || ''),
      turn: normalizeId(match?.turn || ''),
      status: match?.status || 'active',
      winner: normalizeId(match?.winner || ''),
      contest_type: match?.contest_type || '',
      game_type: match?.game_type || 'ludo',
      user1_pieces: Array.isArray(match?.user1_pieces) ? match.user1_pieces : [],
      user2_pieces: Array.isArray(match?.user2_pieces) ? match.user2_pieces : [],
      user1_score: match?.user1_score ?? 0,
      user2_score: match?.user2_score ?? 0,
      user1_time: match?.user1_time || null,
      user2_time: match?.user2_time || null,
      start_time: match?.start_time || null,
      updated_at: match?.updated_at || null
    },
    timestamp: new Date().toISOString()
  };
}

function registerMatchStateHandler(io, socket) {
  socket.removeAllListeners(EVENTS.REQUEST);
  socket.on(EVENTS.REQUEST, async (event) => {
    try {
      await withAuth(socket, event, EVENTS.RESPONSE, async (user, data) => {
        const payload = (data && typeof data === 'object') ? data : {};
        if (!validateRequiredFields(socket, payload, ['game_id', 'contest_id', 'l_id', 'user_id'], EVENTS.RESPONSE)) {
          return;
        }

        const requiredStringFields = ['game_id', 'contest_id', 'l_id', 'user_id'];
        const invalidField = requiredStringFields.find((field) => !normalizeId(payload[field]));
        if (invalidField) {
          emitStandardError(socket, {
            code: 'invalid_value',
            type: 'validation',
            field: invalidField,
            message: `${invalidField} is required and must be non-empty`
          }, EVENTS.RESPONSE);
          return;
        }

        const userId = normalizeId(payload.user_id);
        const authUserId = normalizeId(user?.user_id || socket?.user?.user_id || '');
        if (authUserId && userId !== authUserId) {
          emitStandardError(socket, {
            code: 'auth_failed',
            type: 'authentication',
            field: 'user_id',
            message: 'Request user_id does not match authenticated user'
          }, EVENTS.RESPONSE);
          return;
        }

        const gameId = normalizeId(payload.game_id);
        const match = await fetchMatchOrEmitError(socket, gameId, redisClient, EVENTS.RESPONSE);
        if (!match) return;

        if (!sameId(userId, match.user1_id) && !sameId(userId, match.user2_id)) {
          emitStandardError(socket, {
            code: 'invalid_user',
            type: 'data',
            field: 'user_id',
            message: 'User not part of this match'
          }, EVENTS.RESPONSE);
          return;
        }

        socket.emit(EVENTS.RESPONSE, buildMatchStateResponse(match, userId));
      });
    } catch (err) {
      emitStandardError(socket, {
        code: 'handler_error',
        type: 'system',
        field: 'handler',
        message: err?.message || 'Failed to fetch match state'
      }, EVENTS.RESPONSE);
    }
  });
}

module.exports = { registerMatchStateHandler };
