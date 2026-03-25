const EventEmitter = require('events');

// ============================================================================
// Calculates countdown time remaining for the game
// ============================================================================
function calculateGameCountdown(startTime, currentTime, gameDurationSeconds) {
  if (!startTime) return gameDurationSeconds;

  const startTimeMs = new Date(startTime).getTime();
  if (isNaN(startTimeMs)) return gameDurationSeconds;

  const currentTimeMs = currentTime instanceof Date ? currentTime.getTime() : (currentTime || Date.now());
  const elapsedSeconds = Math.floor((currentTimeMs - startTimeMs) / 1000);
  return Math.max(0, gameDurationSeconds - elapsedSeconds);
}

// ============================================================================
// Timer Registry
// ============================================================================
class TimerRegistry {
  constructor() {
    this.activeTimers = new Map();
  }

  // ============================================================================
  // Register an active timer
  // ============================================================================
  registerTimer(gameId, socketId, userId, gameType) {
    if (!gameId || !socketId || !userId || !gameType) {
      return false;
    }

    if (!this.activeTimers.has(gameId)) {
      this.activeTimers.set(gameId, new Set());
    }

    const timerSession = {
      socketId,
      userId,
      gameType,
      startedAt: new Date().toISOString()
    };

    const gameTimers = this.activeTimers.get(gameId);
    gameTimers.add(timerSession);
    return true;
  }

  // ============================================================================
  // Unregister a timer
  // ============================================================================
  unregisterTimer(gameId, socketId = null) {
    if (!gameId) {
      return false;
    }

    if (!this.activeTimers.has(gameId)) {
      return false;
    }

    const sessions = this.activeTimers.get(gameId);
    if (socketId) {
      for (const session of sessions) {
        if (session.socketId === socketId) {
          sessions.delete(session);
          break;
        }
      }
    } else {
      sessions.clear();
    }

    if (sessions.size === 0) {
      this.activeTimers.delete(gameId);
    }

    return true;
  }

  // ============================================================================
  // Unregister all timers for a specific socket (useful for disconnect)
  // ============================================================================
  unregisterTimersBySocket(socketId) {
    if (!socketId) {
      return 0;
    }

    let count = 0;
    const gamesToRemove = [];

    for (const [gameId, sessions] of this.activeTimers.entries()) {
      const toRemove = [];
      for (const session of sessions) {
        if (session.socketId === socketId) {
          toRemove.push(session);
          count++;
        }
      }
      
      for (const session of toRemove) {
        sessions.delete(session);
      }

      if (sessions.size === 0) {
        gamesToRemove.push(gameId);
      }
    }

    for (const gameId of gamesToRemove) {
      this.activeTimers.delete(gameId);
    }

    return count;
  }

  // ============================================================================
  // Get all active timers for a game type
  // ============================================================================
  getActiveTimersByType(gameType) {
    const result = [];
    for (const [gameId, sessions] of this.activeTimers.entries()) {
      for (const session of sessions) {
        if (session.gameType === gameType) {
          result.push({
            gameId,
            ...session
          });
        }
      }
    }
    return result;
  }

  // ============================================================================
  // Get all active timers (all game types)
  // ============================================================================
  getAllActiveTimers() {
    const result = [];
    for (const [gameId, sessions] of this.activeTimers.entries()) {
      for (const session of sessions) {
        result.push({
          gameId,
          ...session
        });
      }
    }
    return result;
  }

  // ============================================================================
  // Check if a timer is active for a game
  // ============================================================================
  hasActiveTimer(gameId) {
    return this.activeTimers.has(gameId) && this.activeTimers.get(gameId).size > 0;
  }

  // ============================================================================
  // Get active timer sessions for a specific game
  // ============================================================================
  getGameTimers(gameId) {
    return this.activeTimers.get(gameId) || new Set();
  }

  // ============================================================================
  // Clear all timers (for cleanup/testing)
  // ============================================================================
  clearAll() {
    this.activeTimers.clear();
  }

  // ============================================================================
  // Get count of active timers
  // ============================================================================
  getActiveTimerCount() {
    let count = 0;
    for (const sessions of this.activeTimers.values()) {
      count += sessions.size;
    }
    return count;
  }

  // ============================================================================
  // Cleanup stale timer sessions (older than specified TTL)
  // ============================================================================
  cleanupStaleSessions(ttlMs = 60 * 60 * 1000) {
    const now = Date.now();
    let removedCount = 0;
    const gamesToRemove = [];

    for (const [gameId, sessions] of this.activeTimers.entries()) {
      const staleSessions = [];
      for (const session of sessions) {
        const sessionAge = now - new Date(session.startedAt).getTime();
        if (sessionAge > ttlMs) {
          staleSessions.push(session);
          removedCount++;
        }
      }

      for (const session of staleSessions) {
        sessions.delete(session);
      }

      if (sessions.size === 0) {
        gamesToRemove.push(gameId);
      }
    }

    for (const gameId of gamesToRemove) {
      this.activeTimers.delete(gameId);
    }

    return removedCount;
  }
}

// ============================================================================
// Timer Event Bus
// ============================================================================
class TimerEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }

  // ============================================================================
  // Emit timer start event (from handler)
  // ============================================================================
  emitTimerStart(gameType, gameId, socketId, userId) {
    this.emit(`timer:start:${gameType}`, {
      gameId,
      socketId,
      userId,
      gameType,
      timestamp: new Date().toISOString()
    });
  }

  // ============================================================================
  // Emit timer stop event (from handler)
  // ============================================================================
  emitTimerStop(gameType, gameId, socketId, userId, reason = 'manual') {
    this.emit(`timer:stop:${gameType}`, {
      gameId,
      socketId,
      userId,
      gameType,
      reason,
      timestamp: new Date().toISOString()
    });
  }

  // ============================================================================
  // Subscribe to timer start events (for cron)
  // ============================================================================
  onTimerStart(gameType, handler) {
    this.on(`timer:start:${gameType}`, handler);
  }

  // ============================================================================
  // Subscribe to timer stop events (for cron)
  // ============================================================================
  onTimerStop(gameType, handler) {
    this.on(`timer:stop:${gameType}`, handler);
  }

  // ============================================================================
  // Unsubscribe from timer start events
  // ============================================================================
  offTimerStart(gameType, handler) {
    this.off(`timer:start:${gameType}`, handler);
  }

  // ============================================================================
  // Unsubscribe from timer stop events
  // ============================================================================
  offTimerStop(gameType, handler) {
    this.off(`timer:stop:${gameType}`, handler);
  }
}

const timerRegistry = new TimerRegistry();
const timerEventBus = new TimerEventBus();

module.exports = {
  calculateGameCountdown,
  timerRegistry,
  TimerRegistry,
  timerEventBus,
  TimerEventBus
};
