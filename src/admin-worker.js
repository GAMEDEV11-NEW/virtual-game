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

async function startAdminWorker() {
  try {
    console.log('[AdminWorker] starting...');

    try {
      const mysqlClient = require('./services/mysql/client');
      await mysqlClient;
      console.log('[AdminWorker] mysql connected');
    } catch (error) {
      console.error('[AdminWorker] mysql not connected:', error?.message || error);
    }

    try {
      const { getRedis } = require('./utils/redis');
      await getRedis();
      console.log('[AdminWorker] redis connected');
    } catch (error) {
      console.error('[AdminWorker] redis not connected:', error?.message || error);
    }

    const { initializeAdminService } = require('./admin');
    await initializeAdminService();
    console.log('[AdminWorker] admin service initialized');
  } catch (error) {
    console.error('[AdminWorker] failed to start:', error?.message || error);
    process.exit(1);
  }
}

startAdminWorker();

process.on('SIGINT', () => {
  try {
    const { stopAdminService } = require('./admin');
    Promise.resolve(stopAdminService()).catch(() => {});
  } catch (_) {
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  try {
    const { stopAdminService } = require('./admin');
    Promise.resolve(stopAdminService()).catch(() => {});
  } catch (_) {
  }
  process.exit(0);
});
