const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const router = express.Router();

console.log('🔵 SSO Routes loaded');

let publicKey;
try {
  const keyPath = path.join(__dirname, '../keys/sso_public.pem');
  console.log(`🔑 Looking for public key at: ${keyPath}`);
  publicKey = fs.readFileSync(keyPath);
  console.log('✅ Public key loaded successfully');
} catch (error) {
  console.error('❌ Failed to load public key:', error.message);
}

const usedTokens = new Set();

router.use((req, res, next) => {
  console.log('🔄 SSO Middleware - Request URL:', req.url);
  
  const pool = req.app.get('pool');
  if (!pool) {
    console.error('❌ Database pool not found in app');
    return res.status(500).json({
      success: false,
      message: 'Database connection not available'
    });
  }
  req.pool = pool;
  console.log('✅ Database pool attached to request');
  next();
});

router.get('/sso/login', async (req, res) => {
  console.log('🚀 SSO Login endpoint hit!');
  const { token } = req.query;

  if (!token) {
    console.log('⚠️ No token provided');
    return res.status(400).json({
      success: false,
      message: 'No token provided'
    });
  }

  try {
    console.log('🔐 Verifying JWT token...');
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: 'gfe-seller-dashboard',
      audience: 'buyer-tool',
    });

    console.log('✅ Token verified!');

    if (usedTokens.has(decoded.jti)) {
      console.log('❌ Token replay detected!');
      return res.status(401).json({
        success: false,
        message: 'Token already used or expired'
      });
    }
    usedTokens.add(decoded.jti);
    setTimeout(() => usedTokens.delete(decoded.jti), 90 * 1000);

    const pool = req.pool;
    const userId = String(decoded.sub);

    const [existing] = await pool.execute(
      "SELECT * FROM users WHERE id = ?",
      [userId]
    );

    if (existing.length === 0) {
      console.log(`🆕 Creating NEW user with ID: ${userId}`);

      const insertData = [
        userId,
        decoded.email,
        null,
        decoded.role || 'seller',
        decoded.name || null,
        decoded.phone || null,
        decoded.package_id || null,
        null
      ];

      try {
        await pool.execute(
          `INSERT INTO users 
          (id, email, password, role, name, phone_number, package_id, package_expire)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          insertData
        );
        console.log('✅ INSERT successful!');
      } catch (dbError) {
        console.error('❌ Database INSERT error:', dbError.message);
        throw dbError;
      }
    } else {
      console.log(`🔄 Updating EXISTING user: ${userId}`);

      const updateData = [
        decoded.email,
        decoded.role || 'seller',
        decoded.name || null,
        decoded.phone || null,
        decoded.package_id || null,
        null,
        userId
      ];

      try {
        await pool.execute(
          `UPDATE users 
           SET email = ?, 
               role = ?, 
               name = ?, 
               phone_number = ?, 
               package_id = ?, 
               package_expire = ?
           WHERE id = ?`,
          updateData
        );
        console.log('✅ UPDATE successful!');
      } catch (dbError) {
        console.error('❌ Database UPDATE error:', dbError.message);
        throw dbError;
      }
    }

    // Fetch full row — matches manual login shape
    const [fullRow] = await pool.execute(
      "SELECT * FROM users WHERE id = ?",
      [userId]
    );

    if (fullRow.length === 0) {
      console.error('❌ CRITICAL: User not found after insert/update!');
      return res.status(500).json({
        success: false,
        message: 'User storage failed'
      });
    }

    const dbUser = fullRow[0];
    console.log('✅ Verification successful:', dbUser);

    // Setup session
    req.session.userId = dbUser.user_id;
    req.session.email = dbUser.email;
    req.session.role = dbUser.role;
    req.session.name = dbUser.name;
    req.session.isSSO = true;

    req.session.save((err) => {
      if (err) {
        console.error('❌ Session save error:', err);
        return res.status(500).json({
          success: false,
          message: 'Session creation failed'
        });
      }

      console.log('✅ Session saved successfully');

      return res.status(200).json({
        success: true,
        message: 'SSO login successful',
        data: {
          seller: {
            id: dbUser.id,
            email: dbUser.email,
            name: dbUser.name,
            phone: dbUser.phone_number,
            package_id: dbUser.package_id,
            pack_exp_date: dbUser.package_expire,
            leadid: dbUser.leadid || null,
            status: dbUser.status || null
          },
          user: {
            id: dbUser.id,
            email: dbUser.email,
            role: dbUser.role,
            name: dbUser.name,
            user_id: dbUser.user_id
          }
        }
      });
    });

  } catch (err) {
    console.error('❌ SSO process failed:', err.message);
    if (err.code) {
      console.error('Database error code:', err.code);
      console.error('SQL Message:', err.sqlMessage);
    }

    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token has expired'
      });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token'
      });
    }
    return res.status(500).json({
      success: false,
      message: err.message || 'SSO verification failed'
    });
  }
});

module.exports = router;