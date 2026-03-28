const withAuth = require('../../middleware/withAuth');
const validateFields = require('../../utils/validateFields');
const { redis } = require('../../utils/redis');
const { REDIS_KEYS } = require('../../constants');

const EVENTS = {
  REQUEST: 'check:opponent:snakes',
  RESPONSE: 'opponent:response:snakes'
};

function normalizeId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function sameId(a, b) {
  const na = normalizeId(a);
  const nb = normalizeId(b);
  return !!na && !!nb && na === nb;
}

function emitPending(socket, userId) {
  socket.emit(EVENTS.RESPONSE, {
    status: 'pending',
    user_id: normalizeId(userId),
    message: 'Waiting for opponent match...'
  });
}

function registerCheckOpponentHandler(io, socket) {
  socket.removeAllListeners(EVENTS.REQUEST);
  socket.on(EVENTS.REQUEST, async (event) => {
    await withAuth(socket, event, EVENTS.RESPONSE, async (user, payload) => {
      const data = (payload && typeof payload === 'object') ? payload : {};
      if (!validateFields(socket, data, ['game_id', 'user_id'], EVENTS.RESPONSE)) return;

      const gameId = normalizeId(data.game_id);
      const userId = normalizeId(data.user_id || user?.user_id);
      const match = await redis.get(REDIS_KEYS.SNAKES_MATCH(gameId));
      if (!match || typeof match !== 'object') {
        emitPending(socket, userId);
        return;
      }

      const user1 = normalizeId(match.user1_id);
      const user2 = normalizeId(match.user2_id);
      if (!sameId(userId, user1) && !sameId(userId, user2)) {
        emitPending(socket, userId);
        return;
      }

      const opponent = sameId(userId, user1) ? user2 : user1;
      socket.emit(EVENTS.RESPONSE, {
        status: 'success',
        user_id: userId,
        opponent_user_id: opponent,
        game_id: gameId,
        turn_id: normalizeId(match.turn || ''),
        game_status: String(match.status || 'active')
      });
    });
  });
}

module.exports = { registerCheckOpponentHandler };
