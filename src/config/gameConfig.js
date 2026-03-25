// Game configuration and error constants for Ludo

const GAME_CONFIG = {
  DICE: {
    SIX_VALUE: 6,
    FIRST_SIX_REQUIRED_MESSAGE: 'You must roll a 6 before moving out of home.',
    SIX_ONLY_HOME_EXIT_MESSAGE: 'You can only move out of home with a 6.'
  },
  TIMING: {
    ALLOWED_TURN_DELAY_SECONDS: 15
  },
  POSITIONS: {
    HOME_VALUES: ['initial', null, undefined]
  }
};

const ERROR_MESSAGES = {
  VALIDATION: {
    DICE_NUMBER_NON_NUMERIC: 'Dice number must be numeric'
  },
  DATA: {
    GAME_NOT_FOUND: 'No match found for this game_id'
  },
  GAME: {
    NOT_YOUR_TURN: 'It is not your turn.',
    FIRST_SIX_REQUIRED: GAME_CONFIG.DICE.FIRST_SIX_REQUIRED_MESSAGE,
    ILLEGAL_MOVE: GAME_CONFIG.DICE.SIX_ONLY_HOME_EXIT_MESSAGE
  },
  SYSTEM: {
    MOVE_PROCESSING_FAILED: 'Failed to record piece move'
  }
};

const ERROR_CODES = {
  INVALID_VALUE: 'invalid_value',
  NOT_FOUND: 'not_found',
  TURN_EXPIRED: 'turn_expired',
  FIRST_SIX_REQUIRED: 'first_six_required',
  ILLEGAL_MOVE: 'illegal_move',
  VERIFICATION_ERROR: 'verification_error'
};

const ERROR_TYPES = {
  VALIDATION: 'validation',
  DATA: 'data',
  GAME: 'game',
  SYSTEM: 'system'
};

module.exports = {
  GAME_CONFIG,
  ERROR_MESSAGES,
  ERROR_CODES,
  ERROR_TYPES,
};
