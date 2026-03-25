const CONFIG = require('../../config/watersortConfig');

function createEmptyBoard(rows, cols) {
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols).fill(0);
    grid.push(row);
  }
  return grid;
}

function seedTargets(grid, targetCount) {
  let placed = 0;
  const rows = grid.length;
  const cols = grid[0].length;
  while (placed < targetCount) {
    const r = Math.floor(Math.random() * rows);
    const c = Math.floor(Math.random() * cols);
    if (grid[r][c] === 0) {
      grid[r][c] = 2; // 2 = target
      placed++;
    }
  }
}

function createDefaultLevelMap() {
  // Create a default level map structure (4 holders with water colors)
  // This is a fallback when database levels are not available
  return [
    { values: [1, 2, 0, 1] },
    { values: [1, 1, 2, 2] },
    { values: [0, 0, 2, 1] },
    { values: [0, 1, 2, 0] }
  ];
}

async function createInitialWaterSortMatch(gameId, userId) {
  const now = new Date().toISOString();
  
  // Create 5 levels for the multi-stage system (same structure as cron matchmaking)
  const levelRanges = [
    [1, 50],
    [50, 100],
    [100, 200],
    [200, 300],
    [300, 400]
  ];
  
  const levels = [];
  let currentLevel = 1;
  
  // Get level cache service
  const { getWaterSortLevelMapData, getAvailableLevelNumbers } = require('../../services/watersort/levelCacheService');
  const availableLevels = await getAvailableLevelNumbers();
  
  // COMPULSORY: Generate exactly 5 levels (one for each stage)
  // Use gameId as seed to ensure deterministic level generation
  // When user2 joins, they will get the SAME levels from Redis
  const gameIdSeed = gameId.toString().split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  
  for (let i = 0; i < 5; i++) {
    const [min, max] = levelRanges[i];
    
    // Filter available levels within range
    const levelsInRange = availableLevels.filter(level => level >= min && level <= max);
    let levelNo;
    
    if (levelsInRange.length > 0) {
      // Use deterministic selection based on gameId + index
      // This ensures both users get the same levels for the same match
      const deterministicSeed = (gameIdSeed + i * 1000) % 1000000;
      levelNo = levelsInRange[deterministicSeed % levelsInRange.length];
    } else {
      // Fallback: use deterministic number in range
      const deterministicSeed = (gameIdSeed + i * 1000) % 1000000;
      levelNo = min + (deterministicSeed % (max - min + 1));
    }
    
    if (i === 0) {
      currentLevel = levelNo;
    }
    
    // Get level map from cache (or database if not cached)
    let levelMap = await getWaterSortLevelMapData(levelNo);
    
    // Fallback to default if level not found
    if (!levelMap || levelMap.length === 0) {
      levelMap = createDefaultLevelMap();
    }
    
    levels.push({
      no: levelNo,
      map: levelMap
    });
  }
  
  // COMPULSORY: Ensure exactly 5 levels are created
  if (levels.length !== 5) {
    // Fallback: pad with default levels if needed
    while (levels.length < 5) {
      levels.push({
        no: 1,
        map: createDefaultLevelMap()
      });
    }
  }

  return {
    game_id: gameId,
    game_type: 'watersort',
    status: 'waiting', // Will be 'active' when opponent joins
    user1_id: userId,
    user2_id: null,
    // Use puzzle_state with 5 levels structure (same as cron matchmaking)
    puzzle_state: {
      levels: levels
    },
    level_no: currentLevel, // Current level number
    scores: { [userId]: 0 },
    user1_score: 0,  // Track user1's score
    user2_score: 0,  // Track user2's score (will be set when they join)
    created_at: now,
    updated_at: now,
    start_time: null,
    completed_at: null,
    winner: null,
    game_end_reason: null,
    user1_start_time: now, // Track when user1 started playing
    user2_start_time: null, // Will be set when user2 joins
    user1_time: now, // Last move time for user1
    user2_time: null, // Last move time for user2
    moveHistory: [], // Initialize empty move history
    // Multi-stage system (5 stages per player)
    user1_current_stage: 1, // Current stage player 1 is on (1-5)
    user2_current_stage: 1, // Current stage player 2 is on (1-5)
    user1_stages_completed: 0, // How many stages user1 completed
    user2_stages_completed: 0, // How many stages user2 completed
  };
}

module.exports = {
  createInitialWaterSortMatch,
};


