const mysql = require('mysql2/promise');
const { config } = require('./config');

let pool;

async function initMySQL() {
  if (pool) return pool;

  pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    database: config.mysql.database,
    user: config.mysql.user,
    password: config.mysql.password,
    waitForConnections: true,
    connectionLimit: config.mysql.connectionLimit,
    queueLimit: 0
  });

  await pool.query('SELECT 1');
  return pool;
}

function getPool() {
  if (!pool) {
    throw new Error('MySQL not initialized. Call initMySQL() first.');
  }
  return pool;
}

async function closeMySQL() {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}

module.exports = {
  initMySQL,
  getPool,
  closeMySQL
};
