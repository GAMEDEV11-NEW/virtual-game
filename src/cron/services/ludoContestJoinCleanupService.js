const mysqlClient = require('../../services/mysql/client');
const { getRedisService } = require('../../utils/redis');

const ACTIVE_STATUSES = new Set(['pending', 'matched', 'active']);

function parseContestJoinKey(key) {
  const value = String(key || '');
  const parts = value.split(':');
  if (parts.length < 4) return null;
  if (parts[0] !== 'contest_join') return null;
  return {
    key: value,
    userId: parts[1] || '',
    contestId: parts[2] || '',
    lId: parts.slice(3).join(':') || ''
  };
}

class LudoContestJoinCleanupService {
  constructor(session = null) {
    this.session = session || mysqlClient;
    this.redis = null;
    this.isProcessing = false;
  }

  _resolveScanCount() {
    const value = Number(process.env.LUDO_CONTEST_JOIN_CLEANUP_SCAN_COUNT || 1000);
    if (!Number.isFinite(value) || value <= 0) return 1000;
    return Math.min(Math.floor(value), 10000);
  }

  async _getRedis() {
    if (!this.redis) {
      this.redis = getRedisService();
    }
    return this.redis;
  }

  async _getJoinStatusByLid(lId) {
    const [rows] = await this.session.execute(
      `
        SELECT status, is_deleted
        FROM ludo_game
        WHERE l_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [String(lId)]
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return { exists: false, status: '', isDeleted: 0 };
    }

    const row = rows[0] || {};
    return {
      exists: true,
      status: String(row.status || '').toLowerCase(),
      isDeleted: Number(row.is_deleted || 0)
    };
  }

  async processContestJoinCleanup() {
    if (this.isProcessing) {
      return { scanned: 0, removed: 0 };
    }

    this.isProcessing = true;
    try {
      const redis = await this._getRedis();
      const scanCount = this._resolveScanCount();
      const keys = await redis.scan('contest_join:*', { count: scanCount });
      if (!Array.isArray(keys) || keys.length === 0) {
        return { scanned: 0, removed: 0 };
      }

      let removed = 0;
      for (const key of keys) {
        const parsed = parseContestJoinKey(key);
        if (!parsed || !parsed.lId) continue;

        try {
          const state = await this._getJoinStatusByLid(parsed.lId);
          const shouldDelete =
            !state.exists ||
            state.isDeleted === 1 ||
            !ACTIVE_STATUSES.has(state.status);

          if (shouldDelete) {
            await redis.del(parsed.key);
            removed += 1;
          }
        } catch (_) {
        }
      }

      return { scanned: keys.length, removed };
    } finally {
      this.isProcessing = false;
    }
  }
}

module.exports = { LudoContestJoinCleanupService };
