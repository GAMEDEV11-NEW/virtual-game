const Redis = require('ioredis');
const { config } = require('./config');
const { REDIS_KEYS, REDIS_TTL } = require('../constants');
const { toISOString } = require('./dateUtils');

const DEFAULT_TIMEOUT = 3000;

function parseHostPort(value, fallbackHost = '127.0.0.1', fallbackPort = 6379) {
  if (!value) return { host: fallbackHost, port: fallbackPort };
  const [host, port] = String(value).split(':');
  return {
    host: host || fallbackHost,
    port: Number(port || fallbackPort)
  };
}

function parseClusterNodes(rawNodes, fallbackUrl) {
  const source = rawNodes && rawNodes.trim() !== '' ? rawNodes : fallbackUrl;
  return String(source || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((node) => parseHostPort(node));
}

function isClusterClient(client) {
  return client && typeof client.nodes === 'function';
}

async function scanSingleNode(node, pattern, count = 100) {
  const keys = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await node.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

async function scanAcrossClient(client, pattern, count = 100) {
  if (!isClusterClient(client)) {
    return scanSingleNode(client, pattern, count);
  }
  const masters = client.nodes('master');
  const results = await Promise.all(masters.map((node) => scanSingleNode(node, pattern, count)));
  return [...new Set(results.flat())];
}

function baseRedisOptions(cfg) {
  const options = {
    password: cfg.password || undefined,
    db: cfg.db ?? 0,
    enableReadyCheck: true,
    lazyConnect: false,
    connectTimeout: DEFAULT_TIMEOUT,
    commandTimeout: 5000,
    keepAlive: 60000,
    family: 4,
    maxRetriesPerRequest: null,
    retryStrategy: (times) => {
      const delay = Math.min(times * 100, 5000);
      return delay;
    },
    reconnectOnError: (err) => {
      const targetError = 'READONLY';
      if (err.message.includes(targetError)) {
        return true;
      }
      return false;
    },
    enableOfflineQueue: true,
    showFriendlyErrorStack: false,
    enableAutoPipelining: false
  };
  if (cfg.username && cfg.username.trim() !== '') {
    options.username = cfg.username;
  }
  return options;
}

// ============================================================================
// Build Redis connection options from config
// ============================================================================
function buildRedisOptions(cfg) {
  const { host, port } = parseHostPort(cfg.url);
  const options = {
    ...baseRedisOptions(cfg),
    host,
    port
  };
  if (cfg.tls) options.tls = {};
  return options;
}

function createRedisClient(cfg) {
  if (cfg.clusterMode) {
    const startupNodes = parseClusterNodes(cfg.clusterNodes, cfg.url);
    const redisOptions = baseRedisOptions(cfg);
    delete redisOptions.db;
    if (cfg.tls) redisOptions.tls = {};
    return new Redis.Cluster(startupNodes, {
      dnsLookup: (address, callback) => callback(null, address),
      redisOptions
    });
  }
  return new Redis(buildRedisOptions(cfg));
}

async function closeRedisClient(client) {
  if (!client) return;
  if (typeof client.quit === 'function') {
    try {
      await client.quit();
      return;
    } catch (_) {
    }
  }
  if (typeof client.disconnect === 'function') {
    client.disconnect();
  }
}

// ============================================================================
// Get all Redis configurations
// ============================================================================
function getRedisConfigs() {
  const map = new Map();
  if (config.redis.primary.url) {
    map.set('default', {
      url: config.redis.primary.url,
      username: config.redis.primary.username,
      password: config.redis.primary.password,
      db: config.redis.primary.db,
      clusterMode: config.redis.primary.clusterMode,
      clusterNodes: config.redis.primary.clusterNodes,
      tls: config.redis.primary.tls
    });
  }
  if (config.redis.cache.url) {
    map.set('cache', {
      url: config.redis.cache.url,
      username: config.redis.cache.username,
      password: config.redis.cache.password,
      db: config.redis.cache.db,
      clusterMode: config.redis.cache.clusterMode,
      clusterNodes: config.redis.cache.clusterNodes,
      tls: config.redis.cache.tls
    });
  }
  if (config.redis.session.url) {
    map.set('session', {
      url: config.redis.session.url,
      username: config.redis.session.username,
      password: config.redis.session.password,
      db: config.redis.session.db,
      clusterMode: config.redis.session.clusterMode,
      clusterNodes: config.redis.session.clusterNodes,
      tls: config.redis.session.tls
    });
  }
  return map;
}

// ============================================================================
// Redis Service Class
// ============================================================================
class RedisService {
  constructor(connectionNames) {
    const configs = getRedisConfigs();
    const names = connectionNames && connectionNames.length > 0 ? connectionNames : Array.from(configs.keys());
    if (names.length === 0) {
      throw new Error('No Redis connections configured');
    }
    this.clients = new Map();
    names.forEach((name) => {
      const cfg = configs.get(name);
      if (cfg) {
        this.clients.set(name, createRedisClient(cfg));
      }
    });
    this.defaultClient = this.clients.has('default') ? 'default' : names[0];
  }

  getClient(name = this.defaultClient) {
    const client = this.clients.get(name);
    if (!client) {
      throw new Error(`Redis connection ${name} not found`);
    }
    return client;
  }

  async close(connectionName) {
    if (connectionName) {
      const client = this.clients.get(connectionName);
      if (client) {
        await closeRedisClient(client);
        this.clients.delete(connectionName);
      }
      return;
    }
    await Promise.all(
      Array.from(this.clients.values()).map(async (client) => {
        await closeRedisClient(client);
      })
    );
    this.clients.clear();
  }

  async set(key, value, ttlSeconds = 0, connectionName) {
    if (!key) throw new Error('key required');
    const payload = JSON.stringify(value ?? null);
    const client = this.getClient(connectionName);
    if (ttlSeconds > 0) {
      await client.set(key, payload, 'EX', ttlSeconds);
    } else {
      await client.set(key, payload);
    }
  }

  async get(key, connectionName) {
    if (!key) throw new Error('key required');
    const client = this.getClient(connectionName);
    const value = await client.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (err) {
      return value;
    }
  }

  async del(key, connectionName) {
    const client = this.getClient(connectionName);
    await client.del(key);
  }

  async exists(key, connectionName) {
    const client = this.getClient(connectionName);
    const count = await client.exists(key);
    return count > 0;
  }

  async ttl(key, connectionName) {
    const client = this.getClient(connectionName);
    return client.ttl(key);
  }

  async scan(pattern, { count = 100, connectionName } = {}) {
    const client = this.getClient(connectionName);
    return scanAcrossClient(client, pattern, count);
  }
}

let redisService;

// ============================================================================
// Get or create Redis service instance
// ============================================================================
function getRedisService() {
  if (!redisService) {
    redisService = new RedisService();
  }
  return redisService;
}

// ============================================================================
// Close Redis service and cleanup
// ============================================================================
async function closeRedisService() {
  if (redisService) {
    await redisService.close();
    redisService = undefined;
  }
}

// ============================================================================
// Create simple Redis client for basic operations
// ============================================================================
function createSimpleRedisClient() {
  const cfg = getRedisConfigs().get('default') || {
    url: config.redis.primary.url,
    username: config.redis.primary.username,
    password: config.redis.primary.password,
    db: config.redis.primary.db,
    clusterMode: config.redis.primary.clusterMode,
    clusterNodes: config.redis.primary.clusterNodes,
    tls: config.redis.primary.tls
  };
  const client = createRedisClient(cfg);

  client.on('error', (err) => {
    process.stderr.write(`[Redis] Connection error: ${err.message}\n`);
    if (err.message && err.message.includes('WRONGPASS')) {
      process.stderr.write('[Redis] Authentication failed. Please check REDIS_USERNAME and REDIS_PASSWORD environment variables.\n');
    }
  });

  const originalSet = client.set.bind(client);
  const originalGet = client.get.bind(client);

  client.set = async function(key, value, ...args) {
    if (typeof value === 'object') {
      value = JSON.stringify(value);
    }

    if (args.length === 1 && typeof args[0] === 'number') {
      return originalSet(key, value, 'EX', args[0]);
    }

    return originalSet(key, value, ...args);
  };

  client.get = async function(key) {
    const value = await originalGet(key);
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (err) {
      return value;
    }
  };

  client.scan = async function(pattern, options = {}) {
    const count = options.count || 100;
    return scanAcrossClient(client, pattern, count);
  };

  client.keys = async function(pattern) {
    return scanAcrossClient(client, pattern, 200);
  };

  return client;
}

let redisClient = null;
let initPromise = null;

// ============================================================================
// Initialize Redis client wrapper
// ============================================================================
async function initialize() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      redisClient = createSimpleRedisClient();
      return redisClient;
    } catch (err) {
      throw err;
    }
  })();

  return initPromise;
}

initialize().catch(() => {});

const redisProxy = new Proxy({}, {
  get(target, prop) {
    if (redisClient) {
      const value = redisClient[prop];
      if (typeof value === 'function') {
        return value.bind(redisClient);
      }
      return value;
    }

    const asyncMethods = ['get', 'set', 'del', 'exists', 'keys', 'scan', 'ttl', 'expire', 'incr', 'decr', 'hget', 'hset', 'hdel', 'hgetall', 'sadd', 'srem', 'smembers', 'zadd', 'zrem', 'zrange'];

    if (typeof prop === 'string' && asyncMethods.includes(prop)) {
      return async (...args) => {
        const client = await initPromise;
        return client[prop](...args);
      };
    }

    if (prop === 'then' || prop === 'catch' || prop === 'finally') {
      return initPromise[prop].bind(initPromise);
    }

    return initPromise.then(client => {
      const value = client[prop];
      return typeof value === 'function' ? value.bind(client) : value;
    });
  }
});

// ============================================================================
// Retry Redis operation with exponential backoff
// ============================================================================
async function retryRedisOperation(operation, maxRetries = 3, initialDelayMs = 100) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (err.message && (err.message.includes('key required') || err.message.includes('invalid'))) {
        throw err;
      }
      if (attempt === maxRetries) {
        throw err;
      }
      const delay = initialDelayMs * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// ============================================================================
// Safely parses Redis data that may be either a string or already-parsed object
// ============================================================================
function safeParseRedisData(data) {
  if (!data) return null;

  if (typeof data === 'object' && data !== null) {
    return data;
  }

  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch (err) {
      return null;
    }
  }
  
  return null;
}

// ============================================================================
// Gets the appropriate Redis match key based on game type
// ============================================================================
function getMatchKey(gameId, gameType = 'ludo') {
  switch (gameType.toLowerCase()) {
    case 'snakesladders':
    case 'snakes_ladders':
      return REDIS_KEYS.SNAKES_MATCH(gameId);
    case 'tictactoe':
    case 'tic_tac_toe':
      return REDIS_KEYS.TICTACTOE_MATCH(gameId);
    case 'watersort':
    case 'water_sort':
      return REDIS_KEYS.WATERSORT_MATCH(gameId);
    case 'ludo':
    default:
      return REDIS_KEYS.MATCH(gameId);
  }
}

// ============================================================================
// Gets the appropriate Redis user chance key based on game type
// ============================================================================
function getUserChanceKey(gameId, gameType = 'ludo') {
  switch (gameType.toLowerCase()) {
    case 'snakesladders':
    case 'snakes_ladders':
      return REDIS_KEYS.SNAKES_USER_CHANCE(gameId);
    case 'tictactoe':
    case 'tic_tac_toe':
      return REDIS_KEYS.TICTACTOE_USER_CHANCE(gameId);
    case 'watersort':
    case 'water_sort':
      return REDIS_KEYS.WATERSORT_USER_CHANCE(gameId);
    case 'ludo':
      return null;
    default:
      return null;
  }
}

// ============================================================================
// Fetches match from Redis by game ID with retry logic
// ============================================================================
async function fetchMatch(redisClient, gameId, gameType = 'ludo') {
  const matchKey = getMatchKey(gameId, gameType);
  const matchRaw = await retryRedisOperation(
    () => redisClient.get(matchKey),
    3,
    100
  );
  if (!matchRaw) return null;
  return safeParseRedisData(matchRaw);
}

// ============================================================================
// Saves match to Redis with retry logic
// ============================================================================
async function saveMatch(redisClient, gameId, match, gameType = 'ludo', ttlSeconds = null) {
  const matchKey = getMatchKey(gameId, gameType);
  const ttl = ttlSeconds !== null ? ttlSeconds : REDIS_TTL.MATCH_SECONDS;
  await retryRedisOperation(
    () => redisClient.set(matchKey, JSON.stringify(match), ttl),
    3,
    100
  );
}

// ============================================================================
// Updates match fields (merges with existing data) with atomic read-modify-write
// ============================================================================
async function updateMatchFields(redisClient, gameId, partialUpdate, gameType = 'ludo', maxRetries = 3) {
  const matchKey = getMatchKey(gameId, gameType);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await redisClient.watch(matchKey);

      const latestRaw = await redisClient.get(matchKey);
      if (!latestRaw) {
        await redisClient.unwatch();
        return false;
      }

      const latest = safeParseRedisData(latestRaw);
      if (!latest) {
        await redisClient.unwatch();
        return false;
      }

      const merged = { 
        ...latest, 
        ...partialUpdate, 
        updated_at: toISOString() 
      };

      const multi = redisClient.multi();
      multi.set(matchKey, JSON.stringify(merged), 'EX', REDIS_TTL.MATCH_SECONDS);
      const results = await multi.exec();

      if (results && results.length > 0 && results[0][0] === null) {
        return true;
      }

      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
      }
    } catch (error) {
      await redisClient.unwatch().catch(() => {});
      if (attempt === maxRetries - 1) {
        return false;
      }
    }
  }

  return false;
}

// ============================================================================
// Atomic read-modify-write operation using WATCH/MULTI/EXEC
// ============================================================================
async function atomicReadModifyWrite(redisClient, key, modifyFn, ttlSeconds = null, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await redisClient.watch(key);

      const currentRaw = await redisClient.get(key);
      const current = safeParseRedisData(currentRaw);

      const modified = await modifyFn(current);

      const multi = redisClient.multi();
      if (ttlSeconds !== null) {
        multi.set(key, JSON.stringify(modified), 'EX', ttlSeconds);
      } else {
        multi.set(key, JSON.stringify(modified));
      }
      const results = await multi.exec();

      if (results && results.length > 0 && results[0][0] === null) {
        return { success: true, value: modified };
      }

      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
      }
    } catch (error) {
      await redisClient.unwatch().catch(() => {});
      if (attempt === maxRetries - 1) {
        return { success: false, value: null, error: error.message };
      }
    }
  }

  return { success: false, value: null, error: 'Max retries exceeded' };
}

// ============================================================================
// Batch fetch multiple matches from Redis
// ============================================================================
async function fetchMatchesBatch(redisClient, gameIds, gameType = 'ludo') {
  const keys = gameIds.map(id => getMatchKey(id, gameType));
  const values = await Promise.all(keys.map(key => redisClient.get(key)));
  return values.map(value => safeParseRedisData(value));
}

module.exports = {
  RedisService,
  getRedisService,
  closeRedisService,
  createSimpleRedisClient,
  redis: redisProxy,
  getRedis: () => initPromise,
  safeParseRedisData,
  fetchMatch,
  saveMatch,
  updateMatchFields,
  getMatchKey,
  getUserChanceKey,
  fetchMatchesBatch,
  retryRedisOperation,
  atomicReadModifyWrite
};
