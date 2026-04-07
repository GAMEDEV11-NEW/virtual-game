// ============================================================================
// Winner Declaration Service
// Prevents duplicate winner declarations (in-memory + Redis lock)
// ============================================================================

const cassandra = require('cassandra-driver');
const { WalletService } = require('./walletService');
const { redis: redisClient } = require('../../utils/redis');

const INSERT_WINNER = `INSERT INTO winner_declarations (
  game_id, win_month, user_id, declared_at, extra_data, league_id, prize_amount, rank, score, win_loss_status
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// In-memory tracking with TTL cleanup
const declared = new Map(); // Map<gameId, { timestamp: number }>
const DECLARED_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [gameId, data] of declared.entries()) {
    if (now - data.timestamp > DECLARED_TTL_MS) {
      declared.delete(gameId);
    }
  }
}, 60 * 60 * 1000); // Run cleanup every hour

async function tryDeclareWinner(gameId, declareFn) {
  if (declared.has(gameId)) {
    throw new Error(`winner already declared for game ${gameId}`);
  }
  
  const lockKey = `winner_lock:${gameId}`;
  const lockValue = `${Date.now()}-${Math.random()}`;
  const lockTTL = 30; // 30 seconds lock timeout
  
  let lockAcquired = false;
  try {
    const result = await redisClient.set(lockKey, lockValue, 'EX', lockTTL, 'NX');
    lockAcquired = result === 'OK' || result === true;
    
    if (!lockAcquired) {
      throw new Error(`winner already declared for game ${gameId} (lock exists)`);
    }
    
    declared.set(gameId, { timestamp: Date.now() });
    
    try {
      await declareFn();
    } catch (err) {
      await redisClient.del(lockKey).catch(() => {});
      declared.delete(gameId);
      throw err;
    }
  } catch (err) {
    if (!lockAcquired && err.message && !err.message.includes('already declared')) {
      throw new Error(`Failed to acquire lock for game ${gameId}: ${err.message}`);
    }
    throw err;
  }
}

async function isWinnerDeclared(gameId) {
  if (declared.has(gameId)) {
    const data = declared.get(gameId);
    const now = Date.now();
    if (now - data.timestamp > DECLARED_TTL_MS) {
      declared.delete(gameId);
      return false;
    }
    return true;
  }
  
  try {
    const lockKey = `winner_lock:${gameId}`;
    const lockExists = await redisClient.exists(lockKey);
    return lockExists === 1 || lockExists === true;
  } catch (err) {
    return declared.has(gameId);
  }
}

class WinnerDeclarationService {
  constructor(session) {
    this.session = session;
  }

  async processWinnerDeclaration({ gameID, winnerID, loserId, contestID, gameEndReason, winnerScore = 0.0, loserScore = 0.0 }) {
    try {
      if (!gameID || !winnerID) {
        throw new Error(`Missing required parameters: gameID=${gameID}, winnerID=${winnerID}`);
      }
      
      // Use batch operation for atomic insertion of both winner and loser declarations
      await this.#insertWinnersBatch(gameID, winnerID, loserId, contestID, gameEndReason, winnerScore, loserScore);
      
      return {
        success: true,
        winnerID,
        loserId,
        contestID: contestID || '',
        gameID,
        gameEndReason,
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      return {
        success: false,
        error: err.message || 'Unknown error in processWinnerDeclaration',
        errorStack: err.stack,
        gameID,
        winnerID,
        loserId
      };
    }
  }

  async processExpiredEntryRefund(userId, entryFee, joinedAt) {
    const walletService = new WalletService(this.session);
    await walletService.processExpiredEntryRefund(userId, entryFee, joinedAt);
  }

  // ============================================================================
  // Insert both winner and loser declarations using batch operation for atomicity
  // ============================================================================
  async #insertWinnersBatch(gameId, winnerId, loserId, leagueId, reason, winnerScore, loserScore) {
    if (gameId == null || winnerId == null) {
      throw new Error(`Cannot insert winners: missing gameId or winnerId (gameId=${gameId}, winnerId=${winnerId})`);
    }
    
    const now = new Date();
    const winMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    const queries = [
      {
        query: INSERT_WINNER,
        params: [
          gameId,
          winMonth,
          winnerId,
          now,
          reason || '',
          leagueId || '',
          0, // prizeAmount (handled separately in wallet service)
          1, // rank
          winnerScore,
          'win'
        ]
      }
    ];

    if (loserId) {
      queries.push({
        query: INSERT_WINNER,
        params: [
          gameId,
          winMonth,
          loserId,
          now,
          reason || '',
          leagueId || '',
          0, // prizeAmount
          2, // rank
          loserScore,
          'loss'
        ]
      });
    }

    await this.session.batch(queries, {
      prepare: true,
      consistency: cassandra.types.consistencies.localQuorum || 6
    });
  }

}

module.exports = {
  WinnerDeclarationService,
  tryDeclareWinner,
  isWinnerDeclared
};

