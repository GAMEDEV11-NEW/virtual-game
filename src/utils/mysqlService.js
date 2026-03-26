const mysql = require('mysql2/promise');
const { config } = require('./config');

const pools = new Map();

function getDbConfig(name = 'primary') {
  if (name === 'secondary') {
    return config.mysqlSecondary;
  }
  return config.mysql;
}

async function initMySQL(name = 'primary') {
  if (pools.has(name)) return pools.get(name);

  const dbConfig = getDbConfig(name);
  if (!dbConfig || !dbConfig.database) {
    throw new Error(`MySQL ${name} database is not configured.`);
  }

  const pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    waitForConnections: true,
    connectionLimit: dbConfig.connectionLimit,
    queueLimit: 0
  });

  await pool.query('SELECT 1');
  pools.set(name, pool);
  return pool;
}

function getPool(name = 'primary') {
  const pool = pools.get(name);
  if (!pool) {
    throw new Error(`MySQL ${name} is not initialized. Call initMySQL('${name}') first.`);
  }
  return pool;
}

async function closeMySQL(name = 'primary') {
  const pool = pools.get(name);
  if (!pool) return;
  await pool.end();
  pools.delete(name);
}

async function closeAllMySQL() {
  const names = Array.from(pools.keys());
  await Promise.all(names.map((name) => closeMySQL(name)));
}

module.exports = {
  initMySQL,
  getPool,
  closeMySQL,
  closeAllMySQL
};
