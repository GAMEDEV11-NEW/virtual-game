const mysqlClient = require('../../services/mysql/client');
const { DB_QUERIES, GAME_STATUS } = require('../../constants');
const { getRedisService } = require('../../utils/redis');

class LudoSettlementService {
  constructor(session = null) {
    this.session = session || mysqlClient;
    this.redis = null;
    this.isProcessing = false;
  }

  _resolveBatchSize() {
    const value = Number(process.env.LUDO_STALE_SETTLE_BATCH_SIZE || 500);
    if (!Number.isFinite(value) || value <= 0) return 500;
    return Math.min(Math.floor(value), 5000);
  }

  async _getRedis() {
    if (!this.redis) {
      this.redis = getRedisService();
    }
    return this.redis;
  }

  async processStaleEntries() {
    if (this.isProcessing) {
      return { scanned: 0, settled: 0 };
    }

    this.isProcessing = true;
    try {
      const batchSize = this._resolveBatchSize();
      const [rows] = await this.session.execute(DB_QUERIES.LUDO_SELECT_STALE_UNSETTLED, [batchSize]);
      if (!Array.isArray(rows) || rows.length === 0) {
        return { scanned: 0, settled: 0 };
      }

      let settled = 0;
      const redis = await this._getRedis();

      for (const row of rows) {
        const lId = row?.l_id != null ? String(row.l_id) : '';
        if (!lId) continue;
        const [updateResult] = await this.session.execute(
          DB_QUERIES.LUDO_SETTLE_STALE_BY_LID,
          [GAME_STATUS.EXPIRED, 6, lId]
        );

        if ((updateResult?.affectedRows || 0) > 0) {
          settled += 1;
          const userId = row?.user_id != null ? String(row.user_id) : '';
          const contestId = row?.contest_id != null ? String(row.contest_id) : '';
          if (userId && contestId) {
            const contestJoinKey = `contest_join:${userId}:${contestId}:${lId}`;
            try {
              await redis.del(contestJoinKey);
            } catch (_) {
            }
          }
        }
      }

      return { scanned: rows.length, settled };
    } finally {
      this.isProcessing = false;
    }
  }
}

module.exports = { LudoSettlementService };
