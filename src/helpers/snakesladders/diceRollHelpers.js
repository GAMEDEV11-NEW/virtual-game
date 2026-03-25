const { generateDiceRoll } = require('../common/gameHelpers');

// ============================================================================
// Generates a dice number with six detection
// ============================================================================
function generateDiceNumber() {
  const diceNumber = generateDiceRoll();
  const isSix = diceNumber === 6;
  return { diceNumber, isSix, canRollAgain: isSix, consecutiveSixes: 0 };
}

// ============================================================================
// Processes a dice roll for Snakes and Ladders with consecutive six tracking
// ============================================================================
async function processDiceRoll(params, user_id, match = null) {
  try {
    const diceResult = generateDiceNumber();
    const timestamp = new Date().toISOString();

    // Track consecutive sixes if match is provided
    let consecutiveSixes = 0;
    let shouldLoseTurn = false;
    
    if (match) {
      const consecutiveSixKey = getConsecutiveSixKey(match, user_id);
      const currentConsecutiveCount = match[consecutiveSixKey] || 0;
      
      if (diceResult.isSix) {
        consecutiveSixes = currentConsecutiveCount + 1;
        // If 3 consecutive sixes, lose turn
        if (consecutiveSixes >= 3) {
          shouldLoseTurn = true;
          diceResult.canRollAgain = false;
          diceResult.specialRule = 'three_consecutive_sixes';
        }
      } else {
        // Reset counter if not a six
        consecutiveSixes = 0;
      }
      
      // Update match state
      match[consecutiveSixKey] = consecutiveSixes;
    }

    const response = {
      status: 'success',
      message: diceResult.isSix 
        ? (shouldLoseTurn 
          ? 'You rolled 3 consecutive sixes! Turn passes to opponent.' 
          : 'Dice rolled successfully - You got a six!')
        : 'Dice rolled successfully',
      game_id: params.game_id,
      user_id: user_id,
      dice_number: diceResult.diceNumber,
      timestamp: timestamp,
      game_type: 'snakes_ladders',
      is_six: diceResult.isSix,
      can_roll_again: diceResult.canRollAgain,
      consecutive_sixes: consecutiveSixes,
      special_rule: diceResult.specialRule || null,
      should_lose_turn: shouldLoseTurn
    };

    return response;
  } catch (error) {
    throw new Error(`Failed to process dice roll: ${error.message}`);
  }
}

// ============================================================================
// Gets the consecutive six key for a user in the match
// ============================================================================
function getConsecutiveSixKey(match, user_id) {
  if (user_id === match.user1_id) return 'consecutive_six_user1';
  if (user_id === match.user2_id) return 'consecutive_six_user2';
  return null;
}

// ============================================================================
// Broadcasts dice roll result to opponent
// ============================================================================
async function broadcastDiceRollToOpponent(io, opponentSocketId, diceRollData) {
  try {
    if (!opponentSocketId) {
      return false;
    }
    
    const socketExists = io.sockets.sockets.has(opponentSocketId);
    
    if (socketExists) {
      const opponentSocket = io.sockets.sockets.get(opponentSocketId);

      if (opponentSocket) {
        io.to(opponentSocketId).emit('snakesladders_dice:roll:opponent', {
          ...diceRollData,
          message: 'Opponent rolled the dice',
          is_opponent_roll: true
        });
        
        return true;
      }
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

module.exports = {
  processDiceRoll,
  broadcastDiceRollToOpponent,
  generateDiceRoll,
  getConsecutiveSixKey,
  generateDiceNumber
};
