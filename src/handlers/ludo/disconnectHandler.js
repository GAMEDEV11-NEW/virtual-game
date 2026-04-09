const { redis } = require('../../utils/redis');
const { REDIS_KEYS } = require('../../constants');

function normalize(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function getUserIDFromSocket(socket) {
  return (
    normalize(socket?.user?.user_id) ||
    normalize(socket?.handshake?.auth?.user_id) ||
    normalize(socket?.handshake?.query?.user_id)
  );
}

async function cleanupSocketMappings(socket) {
  const socketId = normalize(socket?.id);
  const userId = getUserIDFromSocket(socket);
  const lidFromSocket = normalize(socket?.user?.contest_join_data?.l_id || socket?.contestJoinData?.l_id);

  if (socketId) {
    try {
      await redis.del(REDIS_KEYS.SOCKET_TO_USER(socketId));
    } catch (_) {
    }
  }

  if (userId) {
    try {
      const mappedSocketId = normalize(await redis.get(REDIS_KEYS.USER_TO_SOCKET(userId)));
      if (!mappedSocketId || mappedSocketId === socketId) {
        await redis.del(REDIS_KEYS.USER_TO_SOCKET(userId));
      }
    } catch (_) {
    }
  }

  let lid = lidFromSocket;
  if (!lid && socketId) {
    try {
      lid = normalize(await redis.get(REDIS_KEYS.SOCKET_TO_LID(socketId)));
    } catch (_) {
    }
  }

  if (socketId) {
    try {
      await redis.del(REDIS_KEYS.SOCKET_TO_LID(socketId));
    } catch (_) {
    }
  }

  if (lid) {
    try {
      const mappedSocketId = normalize(await redis.get(REDIS_KEYS.LID_TO_SOCKET(lid)));
      if (!mappedSocketId || mappedSocketId === socketId) {
        await redis.del(REDIS_KEYS.LID_TO_SOCKET(lid));
      }
    } catch (_) {
    }
  }
}

function registerDisconnectHandler(io, socket) {
  socket.removeAllListeners('disconnect');
  socket.on('disconnect', async () => {
    if (socket._ludoFinishWatcherInterval) {
      try {
        clearInterval(socket._ludoFinishWatcherInterval);
      } catch (_) {
      }
      socket._ludoFinishWatcherInterval = null;
    }
    await cleanupSocketMappings(socket);
  });
}

module.exports = {
  getUserIDFromSocket,
  registerDisconnectHandler
};
