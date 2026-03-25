const SCORE_CONFIG = {
  // ============================================================================
  // DICE ROLL SCORING
  // ============================================================================
  DICE_ROLL: {
    SIX: 6,                    // Rolling a 6
    CONSECUTIVE_SIX: 2,         // Each consecutive 6 (bonus)
    FIRST_SIX: 6,              // First 6 of the game
    LUCKY_ROLL: 25,              // Rolling 1 (considered lucky in some cultures)
    BASE_MULTIPLIER: 10          // Base score = dice number × this multiplier
  },

  // ============================================================================
  // PIECE MOVEMENT SCORING
  // ============================================================================
  PIECE_MOVEMENT: {
    KILL_OPPONENT: 20,          // Capturing opponent piece
    SAFE_SPOT: 5,               // Landing on safe square
    HOME_REACH: 40,             // Piece reaching home
    PERFECT_MOVE: 10,            // Moving exactly to home (no overshoot)
    FAST_START: 8,             // Getting piece out in first 3 turns
    NORMAL_MOVE: 1               // Basic points for any piece movement
  },

  // ============================================================================
  // ACHIEVEMENT SCORING
  // ============================================================================
  ACHIEVEMENT: {
    FIRST_PIECE_OUT: 10,        // First piece out of home
    ALL_PIECES_OUT: 20,         // All pieces out of home
    CONSECUTIVE_KILLS: 10,      // Multiple kills in a row
    PERFECT_GAME: 120,          // Win without losing any pieces
    SPEED_DEMON: 50,            // Win in under 20 turns
    COMEBACK_WIN: 60            // Win after being behind by 3+ pieces
  },

  // ============================================================================
  // GAME COMPLETION SCORING
  // ============================================================================
  GAME_COMPLETION: {
    WIN: 200,                   // Winning the game
    SECOND_PLACE: 80,           // Coming in second
    PARTICIPATION: 20,          // Completing the game
    QUICK_WIN_BONUS: 40,        // Win in under 15 turns
    PERFECT_WIN_BONUS: 40       // Win without any opponent kills
  },

  // ============================================================================
  // BONUS SCORING
  // ============================================================================
  BONUS: {
    TURN_EFFICIENCY: 10,         // Making moves quickly
    STRATEGIC_PLAY: 10,          // Smart piece placement
    COMEBACK: 60,               // Winning from behind
    TEAM_PLAY: 15,               // Helping opponent (if applicable)
    STREAK_BONUS: 20,           // Consecutive successful moves
    DEFENSIVE_PLAY: 8           // Successfully defending pieces
  },

  // ============================================================================
  // SPECIAL EVENTS SCORING
  // ============================================================================
  SPECIAL_EVENTS: {
    DOUBLE_KILL: 15,            // Killing 2 pieces in one move
    TRIPLE_KILL: 35,            // Killing 3 pieces in one move
    QUADRUPLE_KILL: 70,         // Killing 4 pieces in one move
    SAFE_PASSAGE: 6,            // Moving through dangerous area safely
    PERFECT_ROUND: 15,          // All moves in a round are optimal
    OPPONENT_BLOCK: 6           // Successfully blocking opponent's path
  },

  // ============================================================================
  // TIME-BASED SCORING
  // ============================================================================
  TIME_BASED: {
    FAST_TURN: 4,               // Completing turn in under 10 seconds
    SLOW_TURN_PENALTY: -5,      // Taking more than 30 seconds
    GAME_SPEED_BONUS: 25,       // Completing game in under 10 minutes
    EFFICIENT_PLAY: 10           // Making moves within time limits consistently
  },

  // ============================================================================
  // MULTIPLIER CONFIGURATIONS
  // ============================================================================
  MULTIPLIERS: {
    FIRST_GAME_OF_DAY: 1.2,      // First game of the day gets 1.5x points
    WEEKEND_BONUS: 1.1,          // Weekend games get 1.2x points
    STREAK_MULTIPLIER: 0.05,      // Each consecutive win adds 0.1x
    MAX_STREAK_MULTIPLIER: 1.5,  // Maximum streak multiplier
    NEW_PLAYER_BONUS: 1.1        // New players get 1.3x points for first 5 games
  },

  // ============================================================================
  // PENALTY CONFIGURATIONS
  // ============================================================================
  PENALTIES: {
    DISCONNECT_PENALTY: -15,     // Penalty for disconnecting
    TIMEOUT_PENALTY: -25,       // Penalty for timing out
    INVALID_MOVE_PENALTY: -8,   // Penalty for invalid moves
    CHEATING_PENALTY: -150,      // Penalty for detected cheating
    SPAM_PENALTY: -10            // Penalty for spamming actions
  },

  // ============================================================================
  // LEVEL-BASED SCORING
  // ============================================================================
  LEVEL_BASED: {
    BEGINNER_MULTIPLIER: 1.0,    // Beginner level (0-100 points)
    INTERMEDIATE_MULTIPLIER: 1.05, // Intermediate level (101-500 points)
    ADVANCED_MULTIPLIER: 1.1,    // Advanced level (501-1000 points)
    EXPERT_MULTIPLIER: 1.15,      // Expert level (1001+ points)
    MASTER_MULTIPLIER: 1.2       // Master level (special achievement)
  },

  // ============================================================================
  // SEASONAL/EVENT SCORING
  // ============================================================================
  SEASONAL: {
    HOLIDAY_BONUS: 1.1,         // Holiday season bonus
    TOURNAMENT_BONUS: 1.2,       // Tournament games bonus
    WEEKLY_CHALLENGE: 1.05,       // Weekly challenge bonus
    MONTHLY_LEAGUE: 1.1,         // Monthly league bonus
    YEARLY_CHAMPIONSHIP: 1.3     // Yearly championship bonus
  }
};

// ============================================================================
// Gets the base score for a dice roll
// ============================================================================
function getDiceBaseScore(diceNumber) {
  return diceNumber * SCORE_CONFIG.DICE_ROLL.BASE_MULTIPLIER;
}

// ============================================================================
// Gets the consecutive six bonus
// ============================================================================
function getConsecutiveSixBonus(consecutiveCount) {
  if (consecutiveCount <= 1) return 0;
  return SCORE_CONFIG.DICE_ROLL.CONSECUTIVE_SIX * (consecutiveCount - 1);
}

// ============================================================================
// Gets the first six bonus
// ============================================================================
function getFirstSixBonus(isFirstSix) {
  return isFirstSix ? SCORE_CONFIG.DICE_ROLL.FIRST_SIX : 0;
}

// ============================================================================
// Gets the lucky roll bonus
// ============================================================================
function getLuckyRollBonus(diceNumber) {
  return diceNumber === 1 ? SCORE_CONFIG.DICE_ROLL.LUCKY_ROLL : 0;
}

// ============================================================================
// Gets the kill bonus
// ============================================================================
function getKillBonus(isKill) {
  return isKill ? SCORE_CONFIG.PIECE_MOVEMENT.KILL_OPPONENT : 0;
}

// ============================================================================
// Gets the home reach bonus
// ============================================================================
function getHomeReachBonus(isHomeReach) {
  return isHomeReach ? SCORE_CONFIG.PIECE_MOVEMENT.HOME_REACH : 0;
}

// ============================================================================
// Gets the safe spot bonus
// ============================================================================
function getSafeSpotBonus(isSafeMove) {
  return isSafeMove ? SCORE_CONFIG.PIECE_MOVEMENT.SAFE_SPOT : 0;
}

// ============================================================================
// Gets the perfect move bonus
// ============================================================================
function getPerfectMoveBonus(isPerfectMove) {
  return isPerfectMove ? SCORE_CONFIG.PIECE_MOVEMENT.PERFECT_MOVE : 0;
}

// ============================================================================
// Gets the fast start bonus
// ============================================================================
function getFastStartBonus(isFastStart) {
  return isFastStart ? SCORE_CONFIG.PIECE_MOVEMENT.FAST_START : 0;
}

module.exports = {
  SCORE_CONFIG,
  getDiceBaseScore,
  getConsecutiveSixBonus,
  getFirstSixBonus,
  getLuckyRollBonus,
  getKillBonus,
  getHomeReachBonus,
  getSafeSpotBonus,
  getPerfectMoveBonus,
  getFastStartBonus
};
