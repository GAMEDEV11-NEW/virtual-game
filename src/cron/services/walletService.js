const cassandra = require('cassandra-driver');
const { v4: uuidv4 } = require('uuid');
const { toFloat } = require('../../utils/dataUtils');
const { getYearMonth } = require('../../utils/dateUtils');

// ============================================================================
// Converts a number to Cassandra BigDecimal
// ============================================================================
function toBigDecimal(value) {
  const normalized = Number(value || 0);
  return cassandra.types.BigDecimal.fromString(normalized.toFixed(2));
}

const ZERO_DEC = toBigDecimal(0);
const DEFAULT_VERSION = 1;

class WalletService {
  constructor(session) {
    this.session = session;
  }

  // ============================================================================
  // Get user wallet balance
  // ============================================================================
  async getUserWalletBalance(userId) {
    const query = 'SELECT balance, win, win_cr, win_db, last_updated, version FROM user_wallet WHERE user_id = ?';
    const result = await this.session.execute(query, [userId], { prepare: true });
    if (!result || result.rowLength === 0) {
      return {
        userId,
        balance: 0,
        win: 0,
        winCr: 0,
        winDb: 0,
        version: 0,
        lastUpdated: null
      };
    }
    const row = result.first();
    return {
      userId,
      balance: toFloat(row.balance),
      win: toFloat(row.win),
      winCr: toFloat(row.win_cr),
      winDb: toFloat(row.win_db),
      version: Number(row.version || 0),
      lastUpdated: row.last_updated || null
    };
  }

  // ============================================================================
  // Create initial wallet for user
  // ============================================================================
  async createInitialWallet(userId) {
    const now = new Date();
    const metadata = JSON.stringify({ created_at: now.toISOString() });
    const query = `INSERT INTO user_wallet (
      user_id, affiliation, affiliation_cr, affiliation_db, balance, credit, debit, discount,
      discount_cr, discount_db, fortune_sack, fortune_sack_cr, fortune_sack_db, last_updated,
      metadata, tds_refund, tds_refund_cr, tds_refund_db, version, win, win_cr, win_db
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.session.execute(query, [
      userId,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      now,
      metadata,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      DEFAULT_VERSION,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC
    ], { prepare: true });
  }

  // ============================================================================
  // Process expired entry refund
  // ============================================================================
  async processExpiredEntryRefund(userId, entryFee, joinedAt) {
    if (!entryFee || entryFee <= 0) {
      return;
    }
    let wallet = await this.getUserWalletBalance(userId);
    if (!wallet || wallet.version === 0) {
      await this.createInitialWallet(userId);
      wallet = await this.getUserWalletBalance(userId);
    }
    const newBalance = wallet.balance + entryFee;
    const newVersion = wallet.version + 1;
    const updateQuery = 'UPDATE user_wallet SET balance = ?, version = ? WHERE user_id = ?';
    await this.session.execute(updateQuery, [toBigDecimal(newBalance), newVersion, userId], { prepare: true });

    const now = new Date();
    const txnMonth = getYearMonth(now);
    const balanceNum = toFloat(wallet.balance);
    const beforeBalance = balanceNum.toFixed(2);
    const metadata = `REFUND=EXPIRED_ENTRY;user_id=${userId};entry_fee=${entryFee.toFixed(2)};balance_before=${beforeBalance};balance_after=${newBalance.toFixed(2)};timestamp=${now.toISOString()}`;
    const historyQuery = `INSERT INTO user_wallet_history (
      user_id, type, txn_month, txn_time, txn_id, affiliation, affiliation_cr, affiliation_db,
      amount, balance_after, discount, discount_cr, discount_db, fortune_sack, fortune_sack_cr,
      fortune_sack_db, metadata, details, tds_refund, tds_refund_cr, tds_refund_db, win, win_cr, win_db
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.session.execute(historyQuery, [
      userId,
      'refund',
      txnMonth,
      now,
      uuidv4(),
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      toBigDecimal(entryFee),
      toBigDecimal(newBalance),
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      metadata,
      'expired entry refund',
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC,
      ZERO_DEC
    ], { prepare: true });
  }
}

module.exports = { WalletService };
