const { redis } = require('../../utils/redis');

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

  if (socketId) {
    try {
      await redis.del(`socket_to_user:${socketId}`);
    } catch (_) {
    }
  }

  if (userId) {
    try {
      const mappedSocketId = normalize(await redis.get(`user_to_socket:${userId}`));
      if (!mappedSocketId || mappedSocketId === socketId) {
        await redis.del(`user_to_socket:${userId}`);
      }
    } catch (_) {
    }
  }
}

function registerDisconnectHandler(io, socket) {
  socket.removeAllListeners('disconnect');
  socket.on('disconnect', async () => {
    await cleanupSocketMappings(socket);
  });
}

module.exports = {
  getUserIDFromSocket,
  registerDisconnectHandler
};
