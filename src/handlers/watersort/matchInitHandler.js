const { redis: redisClient } = require('../../utils/redis');
const withAuth = require('../../middleware/withAuth');
const { emitStandardError, safeParseRedisData } = require('../../utils/gameUtils');
const { createInitialWaterSortMatch } = require('../../helpers/watersort/gameUtils');
const { SOCKET_EVENT } = require('./enums');

function validateInitFields(data) {
  if (!data || !data.user_id) return { ok: false, field: 'user_id' };
  return { ok: true };
}

async function tryFindOrCreateMatch(userId) {
  const waitingKey = 'watersort:waiting:list';
  const existingGameId = await redisClient.lpop(waitingKey);

  if (existingGameId) {
    const matchKey = REDIS_KEYS.WATERSORT_MATCH(existingGameId);
    const raw = await redisClient.get(matchKey);
    if (raw) {
      const match = safeParseRedisData(raw);
      if (!match.user2_id) {
        match.user2_id = userId;
        match.status = GAME_STATUS.ACTIVE;
        match.start_time = new Date().toISOString();
        match.user2_start_time = new Date().toISOString();
        match.user2_time = new Date().toISOString();
        
        await redisClient.set(matchKey, JSON.stringify(match));
        return match;
      }
    }
  }

  const gameId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const match = await createInitialWaterSortMatch(gameId, userId);
  const matchKey = REDIS_KEYS.WATERSORT_MATCH(gameId);
  await redisClient.set(matchKey, JSON.stringify(match));
  await redisClient.rpush(waitingKey, gameId);
  return match;
}

async function registerMatchInitHandler(io, socket) {
  socket.on(SOCKET_EVENT.INIT, async (event) => {
    try {
      await withAuth(socket, event, SOCKET_EVENT.INIT_RESPONSE, async (user, data) => {
        const { user_id } = user;
        const valid = validateInitFields({ user_id });
        if (!valid.ok) {
          emitStandardError(socket, {
            code: 'invalid_request',
            type: 'validation',
            field: valid.field,
            message: 'Missing required field',
            event: SOCKET_EVENT.INIT_RESPONSE,
          });
          return;
        }

        const match = await tryFindOrCreateMatch(user_id);

        socket.emit(SOCKET_EVENT.INIT_RESPONSE, {
          status: 'success',
          match,
        });
      });
    } catch (err) {
      emitStandardError(socket, {
        code: 'internal_error',
        type: 'server',
        message: 'Failed to initialize match',
        event: SOCKET_EVENT.INIT_RESPONSE,
      });
    }
  });
}

module.exports = { registerMatchInitHandler };
