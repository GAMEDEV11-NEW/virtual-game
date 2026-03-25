const { redis: redisClient } = require('../../utils/redis');
const { REDIS_KEYS, DB_QUERIES } = require('../../constants');
const { getRowValue, safeJSONParse } = require('../../utils/dataUtils');

const SELECT_LEVEL_MAP = DB_QUERIES.SELECT_LEVEL_MAP;
const SELECT_ALL_LEVELS = DB_QUERIES.SELECT_ALL_LEVELS;

let levelCacheTimerId = null;
let cassandraSession = null;

// ============================================================================
// Initialize level cache service
// ============================================================================
function initLevelCacheService(session) {
  cassandraSession = session;
  loadAndCacheAllLevels().catch(() => {});
  
  levelCacheTimerId = setInterval(() => {
    loadAndCacheAllLevels().catch(() => {});
  }, 60000);
}

// ============================================================================
// Stop level cache service
// ============================================================================
function stopLevelCacheService() {
  if (levelCacheTimerId) {
    clearInterval(levelCacheTimerId);
    levelCacheTimerId = null;
  }
}

// ============================================================================
// Load all levels from database and cache in Redis
// ============================================================================
async function loadAndCacheAllLevels() {
  if (!cassandraSession) {
    return;
  }

  try {
    const result = await cassandraSession.execute(SELECT_ALL_LEVELS, [], { prepare: false });
    
    if (!result || result.rowLength === 0) {
      return;
    }

    const levelsMap = {};
    
    for (const row of result.rows) {
      const levelNo = getRowValue(row, 'level_no');
      const mapData = getRowValue(row, 'map_data');
      
      if (levelNo != null && mapData) {
        try {
          const raw = typeof mapData === 'string' ? JSON.parse(mapData) : mapData;
          const levelMap = raw.map((item) => ({ 
            values: Array.isArray(item.values) ? item.values : [] 
          }));
          
          const levelKey = REDIS_KEYS.WATERSORT_LEVEL_CACHE(levelNo);
          await redisClient.set(levelKey, JSON.stringify(levelMap), 'EX', 3600);
          
          levelsMap[levelNo] = levelMap;
        } catch (err) {
        }
      }
    }

    const levelNumbers = Object.keys(levelsMap).map(Number).sort((a, b) => a - b);
    await redisClient.set(
      REDIS_KEYS.WATERSORT_LEVELS_CACHE,
      JSON.stringify(levelNumbers),
      'EX',
      3600
    );

  } catch (err) {
  }
}

// ============================================================================
// Get level map data from cache or database
// ============================================================================
async function getWaterSortLevelMapData(levelNo) {
  if (levelNo == null) {
    return null;
  }

  try {
    const levelKey = REDIS_KEYS.WATERSORT_LEVEL_CACHE(levelNo);
    const cached = await redisClient.get(levelKey);
    
    if (cached) {
      try {
        return safeJSONParse(cached);
      } catch (err) {
      }
    }

    if (cassandraSession) {
      try {
        const result = await cassandraSession.execute(SELECT_LEVEL_MAP, [levelNo], { prepare: true });
        if (!result || result.rowLength === 0) {
          return null;
        }
        
        const row = result.first();
        const mapData = getRowValue(row, 'map_data');
        if (!mapData) return null;
        
        try {
          const raw = typeof mapData === 'string' ? JSON.parse(mapData) : mapData;
          const levelMap = raw.map((item) => ({ 
            values: Array.isArray(item.values) ? item.values : [] 
          }));
          
          await redisClient.set(levelKey, JSON.stringify(levelMap), 'EX', 3600);
          
          return levelMap;
        } catch (err) {
          return null;
        }
      } catch (err) {
        return null;
      }
    }

    return null;
  } catch (err) {
    return null;
  }
}

// ============================================================================
// Get available level numbers from cache
// ============================================================================
async function getAvailableLevelNumbers() {
  try {
    const cached = await redisClient.get(REDIS_KEYS.WATERSORT_LEVELS_CACHE);
    if (cached) {
      return safeJSONParse(cached) || [];
    }
  } catch (err) {
  }
  return [];
}

module.exports = {
  initLevelCacheService,
  stopLevelCacheService,
  loadAndCacheAllLevels,
  getWaterSortLevelMapData,
  getAvailableLevelNumbers
};
