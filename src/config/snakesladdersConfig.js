const SNAKES_LADDERS_CONFIG = {
  // Game rules
  TOTAL_SQUARES: 100,
  WINNING_POSITION: 100,
  STARTING_POSITION: 0,
  MAX_PLAYERS: 2,
  MIN_PLAYERS: 2,
  PIECES_PER_PLAYER: 2, // Default pieces per player
  MIN_PIECES_PER_PLAYER: 1, // Minimum pieces per player
  MAX_PIECES_PER_PLAYER: 4, // Maximum pieces per player (can be configured for different game modes)

  // Dice configuration
  DICE: {
    MIN_VALUE: 1,
    MAX_VALUE: 6,
    SIDES: 6
  },

  // Timing configuration
  TIMING: {
    TURN_TIMEOUT_SECONDS: 30,
    GAME_TIMEOUT_MINUTES: 10,
    DISCONNECT_TIMEOUT_SECONDS: 30,
    RECONNECT_WINDOW_SECONDS: 60
  },

  // Timer configuration for timer updates
  TIMER: {
    MAX_TIMER_SECONDS: 30, // Per-turn timer in seconds
    UPDATE_INTERVAL_MS: 1000, // Timer update interval in milliseconds
    GAME_FINISHED_DELAY_MS: 2000, // Delay before disconnecting after game finished
    GAME_DURATION_SECONDS: 600 // Total game duration in seconds (10 minutes)
  },

  // Scoring configuration
  SCORING: {
    BASE_POINTS_PER_MOVE: 1,
    LADDER_BONUS_POINTS: 5,
    SNAKE_PENALTY_POINTS: -5,
    WIN_BONUS_POINTS: 50,
    QUIT_PENALTY_POINTS: -25
  },

  // Board layout
  BOARD: {
    ROWS: 10,
    COLUMNS: 10,
    LADDERS: [
      [4, 25], [13, 46], [33, 49], [42, 63],
      [50, 69], [62, 81], [74, 92]
    ],
    SNAKES: [
      [40, 3], [89, 53], [87, 37], [98, 41]
    ]
  },

  // Game states
  GAME_STATES: {
    WAITING_FOR_OPPONENT: 'waiting_for_opponent',
    ACTIVE: 'active',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    QUIT: 'quit',
    DISCONNECTED: 'player_disconnected'
  },

  // Game end reasons
  GAME_END_REASONS: {
    PLAYER_WON: 'player_won',
    OPPONENT_QUIT: 'opponent_quit',
    OPPONENT_DISCONNECTED: 'opponent_disconnected',
    GAME_TIMEOUT: 'game_timeout',
    MANUAL_QUIT: 'manual_quit',
    AUTO_QUIT: 'auto_quit'
  },

  // Error codes
  ERROR_CODES: {
    INVALID_POSITION: 'invalid_position',
    INVALID_DICE_ROLL: 'invalid_dice_roll',
    ILLEGAL_MOVE: 'illegal_move',
    GAME_NOT_ACTIVE: 'game_not_active',
    INVALID_USER: 'invalid_user',
    MATCH_NOT_FOUND: 'match_not_found',
    GAME_ALREADY_COMPLETED: 'game_already_completed',
    TIMER_EXPIRED: 'timer_expired',
    TURN_EXPIRED: 'turn_expired',
    DISCONNECT_TIMEOUT: 'disconnect_timeout',
    MAX_DISCONNECTS_REACHED: 'max_disconnects_reached'
  },

  // Error types
  ERROR_TYPES: {
    VALIDATION: 'validation',
    GAME: 'game',
    SYSTEM: 'system',
    NETWORK: 'network',
    TIMEOUT: 'timeout'
  },

  // Redis keys
  REDIS_KEYS: {
    MATCH: (gameId) => `snakesladders_match:${gameId}`,
    USER_CHANCE: (gameId) => `snakesladders_userchance:${gameId}`,
    WAITING_PLAYERS: 'snakesladders_waiting_players',
    ACTIVE_GAMES: 'snakesladders_active_games',
    GAME_STATS: (gameId) => `snakesladders_stats:${gameId}`
  },

  // Event names
  EVENTS: {
    // Client to server
    CHECK_OPPONENT: 'snakesladders_check_opponent',
    DICE_ROLL: 'snakesladders_dice:roll',
    PIECE_MOVE: 'snakesladders_piece_move',
    QUIT_GAME: 'snakesladders_quit_game',
    RECONNECT: 'snakesladders_reconnect',
    START_TIMER: 'start:timer_updates_snakesladders',
    STOP_TIMER: 'stop:timer_updates_snakesladders',

    // Server to client
    CHECK_OPPONENT_RESPONSE: 'snakesladders_check_opponent_response',
    DICE_ROLL_RESPONSE: 'snakesladders_dice:roll:response',
    PIECE_MOVE_RESPONSE: 'snakesladders_piece_move_response',
    QUIT_GAME_RESPONSE: 'snakesladders_quit_game_response',
    RECONNECT_RESPONSE: 'snakesladders_reconnect_response',
    TIMER_UPDATE: 'snakesladders_timer_update',
    TIMER_STARTED: 'snakesladders_timer_started',
    TIMER_STOPPED: 'snakesladders_timer_stopped',
    OPPONENT_JOINED: 'snakesladders_opponent_joined',
    OPPONENT_QUIT: 'snakesladders_opponent_quit',
    OPPONENT_DISCONNECTED: 'snakesladders_opponent_disconnected',
    OPPONENT_RECONNECTED: 'snakesladders_opponent_reconnected',
    PIECE_MOVED: 'snakesladders_piece_moved',
    PIECE_MOVED_OPPONENT: 'snakesladders_piece_moved_opponent',
    DICE_ROLL_OPPONENT: 'snakesladders_dice:roll:opponent'
  }
};

const ERROR_MESSAGES = {
  [SNAKES_LADDERS_CONFIG.ERROR_CODES.INVALID_POSITION]: 'Invalid position on the board',
  [SNAKES_LADDERS_CONFIG.ERROR_CODES.INVALID_DICE_ROLL]: 'Invalid dice roll value',
  [SNAKES_LADDERS_CONFIG.ERROR_CODES.ILLEGAL_MOVE]: 'Illegal move - would exceed winning position',
  [SNAKES_LADDERS_CONFIG.ERROR_CODES.GAME_NOT_ACTIVE]: 'Game is not active',
  [SNAKES_LADDERS_CONFIG.ERROR_CODES.INVALID_USER]: 'User is not part of this match',
  [SNAKES_LADDERS_CONFIG.ERROR_CODES.MATCH_NOT_FOUND]: 'Match not found',
  [SNAKES_LADDERS_CONFIG.ERROR_CODES.GAME_ALREADY_COMPLETED]: 'Game is already completed',
  [SNAKES_LADDERS_CONFIG.ERROR_CODES.TIMER_EXPIRED]: 'Your timer has expired',
  [SNAKES_LADDERS_CONFIG.ERROR_CODES.TURN_EXPIRED]: 'It is not your turn',
  [SNAKES_LADDERS_CONFIG.ERROR_CODES.DISCONNECT_TIMEOUT]: 'Disconnect timeout exceeded',
  [SNAKES_LADDERS_CONFIG.ERROR_CODES.MAX_DISCONNECTS_REACHED]: 'Maximum disconnects reached'
};

const SUCCESS_MESSAGES = {
  MATCH_CREATED: 'Match created successfully',
  MATCH_FOUND: 'Match found successfully',
  OPPONENT_JOINED: 'Opponent joined the game',
  DICE_ROLLED: 'Dice rolled successfully',
  PIECE_MOVED: 'Piece moved successfully',
  GAME_QUIT: 'Game quit successfully',
  RECONNECTED: 'Successfully reconnected to all active games',
  TIMER_STARTED: 'Timer updates started successfully',
  TIMER_STOPPED: 'Timer updates stopped successfully'
};

const GAME_STATS_TEMPLATE = {
  total_moves: 0,
  total_dice_rolls: 0,
  ladders_climbed: 0,
  snakes_encountered: 0,
  game_duration_seconds: 0,
  winner: null,
  final_positions: {
    user1: 0,
    user2: 0
  },
  final_scores: {
    user1: 0,
    user2: 0
  }
};

module.exports = {
  SNAKES_LADDERS_CONFIG,
  ERROR_MESSAGES,
  SUCCESS_MESSAGES,
  GAME_STATS_TEMPLATE
};
