const { v4: uuidv4 } = require('uuid');
const cassandraClient = require('../../services/cassandra/client');
const sessionService = require('../../utils/sessionService');
const { redis: redisClient } = require('../../utils/redis');
const { generateDiceRoll } = require('../common/gameHelpers');
const { REDIS_KEYS } = require('../../constants');

const MATCH_ROLL_KEYS = {
  totalRolls: { user1: 'total_rolls_user1', user2: 'total_rolls_user2' },
  lastSix: { user1: 'last_six_get_user1', user2: 'last_six_get_user2' },
  consecutiveSix: { user1: 'consecutive_six_user1', user2: 'consecutive_six_user2' },
};

function generateDiceNumber() {
  const diceNumber = generateDiceRoll();
  const isSix = diceNumber === 6;
  return { diceNumber, isSix, canRollAgain: isSix, consecutiveSixes: 0 };
}

function rollDiceWithSixLogic(
  currentConsecutiveSixes = 0,
  totalRolls = 0,
  lastSixGet = 0,
  firstSixWithinFive = null
) {
  const diceResult = generateDiceNumber();
  diceResult.totalRolls = totalRolls + 1;

  // GUARANTEE FIRST SIX WITHIN 5 ROLLS
  if (lastSixGet === 0 && diceResult.totalRolls === 5 && !diceResult.isSix) {
    // If it's roll 5 and still no six, force a six
    diceResult.diceNumber = 6;
    diceResult.isSix = true;
    diceResult.canRollAgain = true;
  }

  if (diceResult.isSix) {
    diceResult.consecutiveSixes = currentConsecutiveSixes + 1;
    diceResult.lastSixGet = diceResult.totalRolls;
    if (diceResult.consecutiveSixes >= 3) {
      diceResult.specialRule = 'three_consecutive_sixes';
      diceResult.canRollAgain = false;
    }
  } else {
    diceResult.consecutiveSixes = 0;
    diceResult.lastSixGet = lastSixGet;
  }
  diceResult.isFirstSix = diceResult.isSix && lastSixGet === 0;
  if (diceResult.isFirstSix) {
    diceResult.firstSixWithinFive = diceResult.totalRolls <= 5;
  } else if (firstSixWithinFive !== null) {
    diceResult.firstSixWithinFive = firstSixWithinFive;
  } else {
    diceResult.firstSixWithinFive = diceResult.totalRolls <= 5;
  }
  diceResult.dice_six_tracking = {
    isFirstSix: diceResult.isFirstSix,
    totalRolls: diceResult.totalRolls,
    lastSixGet: diceResult.lastSixGet,
    firstSixWithinFive: diceResult.firstSixWithinFive
  };
  return diceResult;
}

// ============================================================================
// Normalizes device ID for comparison (handles type, whitespace, null/undefined)
// ============================================================================
function normalizeDeviceId(deviceId) {
  if (deviceId === null || deviceId === undefined) {
    return '';
  }
  // Convert to string and trim whitespace
  return String(deviceId).trim();
}

// ============================================================================
// Validates user session and device ID
// ============================================================================
async function validateUserSession(userId, { device_id: deviceId }) {
  const session = await sessionService.getSession(userId);
  if (!session) throw new Error('invalid or expired session');
  if (!session.is_active) throw new Error('session is not active');
  
  // Normalize both device IDs before comparison
  const sessionDeviceId = normalizeDeviceId(session.device_id);
  const requestDeviceId = normalizeDeviceId(deviceId);
  
  // Compare normalized values
  if (sessionDeviceId !== requestDeviceId) {
    const refreshedSession = await sessionService.getSessionFromDb(userId);
    if (!refreshedSession) {
      throw new Error('invalid or expired session');
    }
    if (!refreshedSession.is_active) {
      throw new Error('session is not active');
    }

    const refreshedSessionDeviceId = normalizeDeviceId(refreshedSession.device_id);
    if (refreshedSessionDeviceId !== requestDeviceId) {
      const errorMsg = `device ID mismatch: session="${refreshedSessionDeviceId.substring(0, 10)}..." request="${requestDeviceId.substring(0, 10)}..."`;
      throw new Error(errorMsg);
    }
    return refreshedSession;
  }
  
  return session;
}

function resolveMatchKeys(match, userId) {
  if (!match) return {};
  const isUser1 = userId === match.user1_id;
  return {
    totalRollsKey: isUser1 ? MATCH_ROLL_KEYS.totalRolls.user1 : MATCH_ROLL_KEYS.totalRolls.user2,
    lastSixKey: isUser1 ? MATCH_ROLL_KEYS.lastSix.user1 : MATCH_ROLL_KEYS.lastSix.user2,
  };
}

function resolveConsecutiveSixKey(match, userId) {
  if (!match) return null;
  if (userId === match.user1_id) return MATCH_ROLL_KEYS.consecutiveSix.user1;
  if (userId === match.user2_id) return MATCH_ROLL_KEYS.consecutiveSix.user2;
  return null;
}

function readMatchRollCounters(match, keys) {
  if (!match || !keys.totalRollsKey) {
    return { actualTotalRolls: 0, actualLastSixGet: 0 };
  }
  return {
    actualTotalRolls: match[keys.totalRollsKey] || 0,
    actualLastSixGet: match[keys.lastSixKey] || 0,
  };
}

async function persistMatchRollCounters(match, gameId, keys, diceResult, userId) {
  if (!match || !keys.totalRollsKey) return;
  match[keys.totalRollsKey] = diceResult.totalRolls;
  match[keys.lastSixKey] = diceResult.lastSixGet;
  
  // Also persist consecutive six count
  const consecutiveSixKey = resolveConsecutiveSixKey(match, userId);
  if (consecutiveSixKey) {
    match[consecutiveSixKey] = diceResult.consecutiveSixes;
  }
  
  await redisClient.set(REDIS_KEYS.MATCH(gameId), JSON.stringify(match));
}

async function getOrCreateDiceLookupId(gameId, userId) {
  if (gameId == null || userId == null) {
    return null;
  }
  const query = 'SELECT dice_id FROM dice_rolls_lookup WHERE game_id = ? AND user_id = ? LIMIT 1';
  const result = await cassandraClient.execute(query, [gameId, userId], { prepare: true });
  if (result.rowLength > 0 && result.rows[0].dice_id) {
    return result.rows[0].dice_id;
  }
  const lookupDiceID = uuidv4();
  await cassandraClient.execute(
    'INSERT INTO dice_rolls_lookup (game_id, user_id, dice_id, created_at) VALUES (?, ?, ?, ?)',
    [gameId, userId, lookupDiceID, new Date().toISOString()],
    { prepare: true }
  );
  return lookupDiceID;
}

function enqueueDiceRollPersistence({ lookupDiceID, rollID, diceNumber, rollTime, rollReq }) {
  (async () => {
    try {
      await cassandraClient.execute(
        'INSERT INTO dice_rolls_data (lookup_dice_id, roll_id, dice_number, roll_timestamp, session_token, device_id, contest_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          lookupDiceID,
          rollID,
          diceNumber,
          rollTime.toISOString(),
          rollReq.session_token,
          rollReq.device_id,
          rollReq.contest_id,
          rollTime.toISOString(),
        ],
        { prepare: true }
      );
    } catch (err) {
      try {
        const failedData = {
          lookupDiceID,
          rollID,
          diceNumber,
          rollTimestamp: rollTime.toISOString(),
          sessionToken: rollReq.session_token,
          deviceID: rollReq.device_id,
          contestID: rollReq.contest_id,
          createdAt: rollTime.toISOString(),
          error: err.message,
          timestamp: new Date().toISOString(),
        };
        await redisClient.rpush('failed:dice_rolls', JSON.stringify(failedData));
      } catch (_) {
        // Swallow errors while writing to the fallback queue
      }
    }
  })();
}

async function processDiceRoll(rollReq, userId, match = null) {
  await validateUserSession(userId, rollReq);

  const { totalRollsKey, lastSixKey } = resolveMatchKeys(match, userId);
  const { actualTotalRolls, actualLastSixGet } = readMatchRollCounters(match, {
    totalRollsKey,
    lastSixKey,
  });

  // Get consecutive six count from match state (not from rollReq)
  let currentConsecutiveSixes = 0;
  const consecutiveSixKey = resolveConsecutiveSixKey(match, userId);
  if (match && consecutiveSixKey) {
    currentConsecutiveSixes = match[consecutiveSixKey] || 0;
  }

  const diceResult = rollDiceWithSixLogic(
    currentConsecutiveSixes,
    actualTotalRolls || rollReq.totalRolls || 0,
    actualLastSixGet || rollReq.lastSixGet || 0,
    rollReq.firstSixWithinFive || null
  );

  // Update match state with new consecutive six count
  if (match && consecutiveSixKey) {
    match[consecutiveSixKey] = diceResult.consecutiveSixes;
  }

  await persistMatchRollCounters(match, rollReq.game_id, { totalRollsKey, lastSixKey }, diceResult, userId);

  const diceNumber = diceResult.diceNumber;
  const lookupDiceID = await getOrCreateDiceLookupId(rollReq.game_id, userId);
  const rollID = uuidv4();
  const rollTime = new Date();

  enqueueDiceRollPersistence({ lookupDiceID, rollID, diceNumber, rollTime, rollReq });

  const responseData = {
    roll_id: rollID,
    roll_timestamp: rollTime.toISOString(),
    game_name: 'Ludo Game',
    contest_name: rollReq.contest_id,
    is_winner: diceNumber === 6,
    dice_result: {
      number: diceNumber,
      is_six: diceResult.isSix,
      can_roll_again: diceResult.canRollAgain,
      consecutive_sixes: diceResult.consecutiveSixes,
      special_rule: diceResult.specialRule || null,
      dice_six_tracking: diceResult.dice_six_tracking
    },
  };

  return {
    status: 'success',
    message: diceResult.isSix ? 'Dice rolled successfully - You got a six!' : 'Dice rolled successfully',
    game_id: rollReq.game_id,
    user_id: userId,
    dice_id: rollID,
    dice_number: diceNumber,
    roll_time: rollTime.toISOString(),
    contest_id: rollReq.contest_id,
    session_token: rollReq.session_token,
    device_id: rollReq.device_id,
    is_six: diceResult.isSix,
    can_roll_again: diceResult.canRollAgain,
    consecutive_sixes: diceResult.consecutiveSixes,
    special_rule: diceResult.specialRule || null,
    dice_six_tracking: diceResult.dice_six_tracking,
    data: responseData,
    timestamp: new Date().toISOString(),
    socket_id: '',
    event: 'dice:roll:response',
  };
}

async function broadcastDiceRollToOpponent(io, opponentSocketId, payload) {
  try {
    if (!opponentSocketId) {
      return false;
    }
    
    const socketExists = io.sockets.sockets.has(opponentSocketId);
    
    if (socketExists) {
      const opponentSocket = io.sockets.sockets.get(opponentSocketId);
      if (opponentSocket) {
        io.to(opponentSocketId).emit("opponent:dice:roll:update", payload);
        return true;
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}


module.exports = {
  generateDiceNumber,
  rollDiceWithSixLogic,
  processDiceRoll,
  broadcastDiceRollToOpponent,
  getOrCreateDiceLookupId,
};
