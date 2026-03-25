// ============================================================================
// Heartbeat Handler - Server-Side Managed
// Server automatically sends heartbeats to clients every 1 second
// No client-side emits needed - server manages everything
// ============================================================================

const sessionService = require('../../utils/sessionService');
const { redis } = require('../../utils/redis');

const HEARTBEAT_INTERVAL_MS = 1000; // 1 second
const HEARTBEAT_TIMEOUT_MS = 5000; // 5 seconds - disconnect if no response

// ============================================================================
// Send heartbeat to client
// ============================================================================
function sendHeartbeat(socket) {
  try {
    if (!socket || !socket.connected) {
      return false;
    }

    const userId = socket.user?.user_id || null;
    socket.emit('server:heartbeat', {
      status: 'alive',
      timestamp: new Date().toISOString(),
      server_time: Date.now(),
      user_id: userId
    });
    return true;
  } catch (err) {
    return false;
  }
}

// ============================================================================
// Update user session last_seen (non-blocking)
// ============================================================================
async function updateUserLastSeen(userId) {
  if (!userId) return;
  
  try {
    const session = await sessionService.getSession(userId);
    if (session && session.is_active) {
      session.last_seen = new Date().toISOString();
      const sessionKey = `session:${userId}`;
      // Update in background, don't wait
      redis.set(sessionKey, JSON.stringify(session)).catch(() => {});
    }
  } catch (err) {
    // Ignore session update errors
  }
}

// ============================================================================
// Register heartbeat handler - Server-side managed
// ============================================================================
function registerHeartbeatHandler(io, socket) {
  let heartbeatIntervalId = null;
  let lastHeartbeatTime = Date.now();
  let missedHeartbeats = 0;
  const maxMissedHeartbeats = 3;

  // Start server-side heartbeat (server sends to client)
  function startServerHeartbeat() {
    // Clear any existing interval
    if (heartbeatIntervalId) {
      clearInterval(heartbeatIntervalId);
    }

    heartbeatIntervalId = setInterval(() => {
      if (!socket || !socket.connected) {
        stopServerHeartbeat();
        return;
      }

      // Send heartbeat from server to client
      const sent = sendHeartbeat(socket);
      
      if (sent) {
        // Update last heartbeat time
        lastHeartbeatTime = Date.now();
      } else {
        // Failed to send, increment missed count
        missedHeartbeats++;
        if (missedHeartbeats >= maxMissedHeartbeats) {
          // Too many missed heartbeats, disconnect
          stopServerHeartbeat();
          socket.disconnect(true);
          return;
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // Stop server-side heartbeat
  function stopServerHeartbeat() {
    if (heartbeatIntervalId) {
      clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = null;
    }
    missedHeartbeats = 0;
  }

  // Handle client response to server heartbeat (optional - client can acknowledge)
  socket.on('client:heartbeat:response', async (data) => {
    try {
      // Client acknowledged heartbeat, reset missed count
      missedHeartbeats = 0;
      lastHeartbeatTime = Date.now();

      // Update user's last_seen if authenticated
      const userId = socket.user?.user_id;
      if (userId) {
        updateUserLastSeen(userId).catch(() => {});
      }
    } catch (err) {
      // Ignore errors
    }
  });

  // Start heartbeat when socket connects
  startServerHeartbeat();

  // Cleanup on disconnect
  socket.on('disconnect', () => {
    stopServerHeartbeat();
  });

  // Store cleanup function for manual cleanup if needed
  socket._heartbeatCleanup = stopServerHeartbeat;
}

module.exports = { registerHeartbeatHandler };

