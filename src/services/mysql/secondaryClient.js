const { initMySQL, getPool } = require('../../utils/mysqlService');

let mysqlPool = null;
let initPromise = null;

async function initialize() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await initMySQL('secondary');
    mysqlPool = getPool('secondary');
    return mysqlPool;
  })();

  return initPromise;
}

initialize().catch(() => {});

const clientProxy = new Proxy({}, {
  get(target, prop) {
    if (mysqlPool) {
      const value = mysqlPool[prop];
      if (typeof value === 'function') return value.bind(mysqlPool);
      return value;
    }

    if (prop === 'query' || prop === 'execute' || prop === 'getConnection' || prop === 'end') {
      return async (...args) => {
        const pool = await initPromise;
        return pool[prop](...args);
      };
    }

    if (prop === 'then' || prop === 'catch' || prop === 'finally') {
      return initPromise[prop].bind(initPromise);
    }

    return initPromise.then(pool => {
      const value = pool[prop];
      return typeof value === 'function' ? value.bind(pool) : value;
    });
  }
});

module.exports = clientProxy;
