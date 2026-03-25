require('dotenv').config();

process.noDeprecation = true;

if (typeof process.setMaxListeners === 'function') {
  process.setMaxListeners(0);
}

if (global.gc) {
  setInterval(() => {
    try {
      global.gc();
    } catch (_) {
    }
  }, 30000);
}

async function startCronWorker() {
  try {
    const cassandraClient = require('./services/cassandra/client');
    await cassandraClient;

    const { getRedis } = require('./utils/redis');
    await getRedis();

    const { initializeCronService } = require('./cron');
    await initializeCronService(null);
  } catch (_) {
    process.exit(1);
  }
}

startCronWorker();
