const { validateJWTToken } = require('../utils/jwt');
const sessionService = require('../utils/sessionService');
const { redis } = require('../utils/redis');
const { REDIS_KEYS } = require('../constants');

// ============================================================================
// Socket authentication middleware
// ============================================================================
async function socketAuthMiddleware(socket, next) {
  const socketId = socket.id;
  
  const token = socket.handshake.auth?.jwt_token || socket.handshake.query?.jwt_token;
  
  if (!token) {
    return next(new Error('Authentication error: No token provided'));
  }
  
  try {
    const user = await validateJWTToken(token);
    
    if (!user) {
      return next(new Error('Authentication error: Invalid token'));
    }
    
    if (!user.user_id) {
      return next(new Error('Authentication error: Invalid token'));
    }
    
    const existingSession = await sessionService.getSession(user.user_id);
    
    if (existingSession) {
      if (existingSession.socket_id && existingSession.socket_id !== socketId) {
        try {
          const existingSocket = socket.server.sockets.sockets.get(existingSession.socket_id);
          if (existingSocket) {
            existingSocket.disconnect(true);
          }
        } catch (error) {
        }
      }
    }
    
    await sessionService.updateSessionSocketIdForReconnect(user.user_id, socketId);
    
    await cleanupExistingSocketMappings(user.user_id, socketId);
    
    await storeSocketToUserMapping(socketId, user.user_id);
    await storeUserToSocketMapping(user.user_id, socketId);
    
    socket.user = user;
    
    next();
  } catch (err) {
    next(new Error('Authentication error: Invalid token'));
  }
}

// ============================================================================
// Clean up existing socket mappings for a user
// ============================================================================
async function cleanupExistingSocketMappings(userId, newSocketId) {
  try {
    const keys = await redis.keys(`${REDIS_KEYS.SOCKET_TO_USER('*')}`);
    const userSocketMappings = [];
    
    for (const key of keys) {
      const mappedUserId = await redis.get(key);
      if (mappedUserId === userId) {
        const socketId = key.replace('socket_to_user:', '');
        if (socketId !== newSocketId) {
          userSocketMappings.push(socketId);
        }
      }
    }
    
    for (const oldSocketId of userSocketMappings) {
      await redis.del(REDIS_KEYS.SOCKET_TO_USER(oldSocketId));
    }
  } catch (error) {
  }
}

// ============================================================================
// Store socket to user mapping in Redis for fast lookup
// ============================================================================
async function storeSocketToUserMapping(socketId, userId) {
  try {
    await redis.set(REDIS_KEYS.SOCKET_TO_USER(socketId), userId);
  } catch (error) {
    throw error;
  }
}

// ============================================================================
// Store user to socket mapping in Redis
// ============================================================================
async function storeUserToSocketMapping(userId, socketId) {
  try {
    await redis.set(REDIS_KEYS.USER_TO_SOCKET(userId), socketId);
  } catch (error) {
    throw error;
  }
}

module.exports = socketAuthMiddleware;
