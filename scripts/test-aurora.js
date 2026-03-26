const fs = require('fs');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function main() {
  const host = process.env.MYSQL_HOST || 'virtual-game-instance-1.chsqo84agkkk.ap-south-1.rds.amazonaws.com';
  const port = Number(process.env.MYSQL_PORT || 3306);
  const database = process.env.MYSQL_DATABASE || 'mysql';
  const user = process.env.MYSQL_USER || 'admin';
  const password = process.env.MYSQL_PASSWORD;
  const caPath = process.env.MYSQL_SSL_CA || './global-bundle.pem';

  if (!password) {
    throw new Error('Missing MYSQL_PASSWORD in environment.');
  }

  let conn;
  try {
    conn = await mysql.createConnection({
      host,
      port,
      database,
      user,
      password,
      ssl: {
        rejectUnauthorized: true,
        ca: fs.readFileSync(caPath)
      }
    });

    const [rows] = await conn.execute('SELECT VERSION() AS v');
    console.log('Connected. MySQL version:', rows[0].v);
  } finally {
    if (conn) await conn.end();
  }
}

main().catch((err) => {
  console.error('Database error:', err.message);
  process.exit(1);
});
