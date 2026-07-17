const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const publicKey = fs.readFileSync(path.join(__dirname, '../keys/sso_public.pem'));

// Simple in-memory replay-protection store (swap for Redis in production)
const usedTokens = new Set();

router.get('/sso/login', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: 'gfe-seller-dashboard',
      audience: 'buyer-tool',
    });

    // Prevent the same token being replayed
    if (usedTokens.has(decoded.jti)) {
      return res.status(401).send('Token already used or expired');
    }
    usedTokens.add(decoded.jti);
    // Clean up after expiry window (60s handoff token + buffer)
    setTimeout(() => usedTokens.delete(decoded.jti), 90 * 1000);

    // TODO: replace this block with your actual DB user lookup/creation
    let user = await findOrCreateUserByEmail(decoded.email, {
      name: decoded.name,
      externalId: decoded.sub,
      role: decoded.role,
    });

    // Establish the buyer-tool's own session
    req.session.userId = user.id;
    req.session.email = user.email;

    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.redirect('/login?error=session_failed');
      }
      res.redirect('/search'); // buyer tool's real landing page
    });

  } catch (err) {
    console.error('SSO token invalid:', err.message);
    return res.redirect('/login?error=sso_failed');
  }
});

module.exports = router;