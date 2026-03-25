const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-game-admin-backend-2024';

// ============================================================================
// Validates and decodes JWT token
// ============================================================================
function validateJWTToken(tokenString) {
  try {
    const decoded = jwt.verify(tokenString, JWT_SECRET);
    return decoded;
  } catch (err) {
    return null;
  }
}

// ============================================================================
// Decrypts user data using AES-256-CBC with JWT token as key
// ============================================================================
function decryptUserData(encryptedData, jwtToken) {
  try {
    let key = Buffer.from(jwtToken, 'utf8');
    if (key.length < 32) {
      const padded = Buffer.alloc(32);
      key.copy(padded);
      key = padded;
    } else {
      key = key.slice(0, 32);
    }
    const iv = Buffer.alloc(16, 0);
    const ciphertext = Buffer.from(encryptedData, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (err) {
    throw new Error('Decryption failed');
  }
}

// ============================================================================
// Validates JWT claims and emits error if invalid
// ============================================================================
function validateJwtClaims(jwtClaims, socket = null, event = 'connection_error') {
  const invalid = (field, message) => {
    if (socket) {
      try {
        socket.emit(event, {
          status: 'error',
          error_code: 'auth_failed',
          error_type: 'authentication',
          field,
          message,
        });
      } catch (_) {}
    }
    return false;
  };

  if (!jwtClaims || typeof jwtClaims !== 'object') {
    return invalid('jwt_token', 'invalid token payload');
  }
  if (!jwtClaims.mobile_no || jwtClaims.mobile_no.length < 10) {
    return invalid('jwt_token', 'invalid mobile number in JWT token');
  }
  if (!jwtClaims.device_id || jwtClaims.device_id.length < 1) {
    return invalid('jwt_token', 'invalid device ID in JWT token');
  }
  return true;
}

module.exports = {
  validateJWTToken,
  decryptUserData,
  validateJwtClaims,
};
