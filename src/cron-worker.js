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
    console.log('[CronWorker] starting...');
    const mysqlClient = require('./services/mysql/client');
    await mysqlClient;
    console.log('[CronWorker] mysql connected');

    const { getRedis } = require('./utils/redis');
    await getRedis();
    console.log('[CronWorker] redis connected');

    const { initializeCronService } = require('./cron');
    await initializeCronService(null);
    console.log('[CronWorker] cron service initialized');
  } catch (_) {
    console.error('[CronWorker] failed to start');
    process.exit(1);
  }
}

startCronWorker();
