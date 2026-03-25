const path = require('path');
const dotenv = require('dotenv');

const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

// ============================================================================
// Get environment variable with fallback
// ============================================================================
function getEnv(key, fallback = '') {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

// ============================================================================
// Get environment variable as number with fallback
// ============================================================================
function getNumber(key, fallback) {
  const parsed = Number(getEnv(key));
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ============================================================================
// Get environment variable as boolean with fallback
// ============================================================================
function getBoolean(key, fallback = false) {
  const value = getEnv(key, String(fallback)).toLowerCase().trim();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

// ============================================================================
// Configuration object with all application settings
// ============================================================================
const config = {
  port: getNumber('PORT', 3000),
  host: getEnv('HOST', '0.0.0.0'),
  socketCorsOrigin: getEnv('SOCKET_CORS_ORIGIN', '*'),
  logLevel: getEnv('LOG_LEVEL', 'info'),
  mysql: {
    host: getEnv('MYSQL_HOST', '127.0.0.1'),
    port: getNumber('MYSQL_PORT', 3306),
    database: getEnv('MYSQL_DATABASE', 'virtual_game'),
    user: getEnv('MYSQL_USER', 'game_user'),
    password: getEnv('MYSQL_PASSWORD', ''),
    connectionLimit: getNumber('MYSQL_CONNECTION_LIMIT', 10)
  },
  serverPort: getNumber('SERVER_PORT', 3008),
  serverId: getEnv('SERVER_ID', '1'),
  app: {
    name: getEnv('APP_NAME', 'GOSOCKET'),
    version: getEnv('APP_VERSION', '1.0.0')
  },
  matchmaking: {
    ludoLeagueIds: getEnv('LUDO_LEAGUE_IDS', '1,2,3,4,5,6,7,8,9,10,11,12'),
    ticTacToeLeagueIds: getEnv('TICTACTOE_LEAGUE_IDS', '16,17,18'),
    snakesLeagueIds: getEnv('SNAKES_LADDERS_LEAGUE_IDS', '13,14,15'),
    waterSortLeagueIds: getEnv('WATERSORT_LEAGUE_IDS', '19,20,21')
  },
  redis: {
    primary: {
      url: getEnv('REDIS_URL', '127.0.0.1:6379'),
      username: getEnv('REDIS_USERNAME', ''),
      password: getEnv('REDIS_PASSWORD', ''),
      db: getNumber('REDIS_DB', 0),
      clusterMode: getBoolean('REDIS_CLUSTER_MODE', false),
      clusterNodes: getEnv('REDIS_CLUSTER_NODES', ''),
      tls: getBoolean('REDIS_TLS', false),
      poolSize: getNumber('REDIS_POOL_SIZE', 10),
      minIdle: getNumber('REDIS_MIN_IDLE_CONNS', 5)
    },
    cache: {
      url: getEnv('REDIS_CACHE_URL', ''),
      username: getEnv('REDIS_CACHE_USERNAME', ''),
      password: getEnv('REDIS_CACHE_PASSWORD', ''),
      db: getNumber('REDIS_CACHE_DB', 1),
      clusterMode: getBoolean('REDIS_CACHE_CLUSTER_MODE', false),
      clusterNodes: getEnv('REDIS_CACHE_CLUSTER_NODES', ''),
      tls: getBoolean('REDIS_CACHE_TLS', false),
      poolSize: getNumber('REDIS_CACHE_POOL_SIZE', 5),
      minIdle: getNumber('REDIS_CACHE_MIN_IDLE_CONNS', 2)
    },
    session: {
      url: getEnv('REDIS_SESSION_URL', ''),
      username: getEnv('REDIS_SESSION_USERNAME', ''),
      password: getEnv('REDIS_SESSION_PASSWORD', ''),
      db: getNumber('REDIS_SESSION_DB', 2),
      clusterMode: getBoolean('REDIS_SESSION_CLUSTER_MODE', false),
      clusterNodes: getEnv('REDIS_SESSION_CLUSTER_NODES', ''),
      tls: getBoolean('REDIS_SESSION_TLS', false),
      poolSize: getNumber('REDIS_SESSION_POOL_SIZE', 3),
      minIdle: getNumber('REDIS_SESSION_MIN_IDLE_CONNS', 2)
    }
  }
};

module.exports = { config };
