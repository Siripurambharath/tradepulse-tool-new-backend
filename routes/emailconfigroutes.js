// routes/emailConfigRoutes.js
const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');

// router.get('/api/email-configurations/autodiscover', async (req, res) => {
//   const pool = req.app.get('pool');
//   try {
//     const { email, provider } = req.query;

//     if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
//       return res.status(400).json({ success: false, message: 'Invalid email address.' });
//     }

//     const domain = email.split('@')[1].toLowerCase();

//     // DB lookup by domain (primary)
//     let [rows] = await pool.execute(
//       `SELECT provider, domain, smtp_host, smtp_port, imap_host, imap_port
//        FROM email_provider_configurations
//        WHERE domain = ? LIMIT 1`,
//       [domain]
//     );

//     // Fallback by provider name
//     if (rows.length === 0 && provider) {
//       [rows] = await pool.execute(
//         `SELECT provider, domain, smtp_host, smtp_port, imap_host, imap_port
//          FROM email_provider_configurations
//          WHERE LOWER(provider) = LOWER(?) LIMIT 1`,
//         [provider]
//       );
//     }

//     if (rows.length > 0) {
//       return res.json({
//         success: true,
//         source: 'database',
//         provider: rows[0].provider,
//         domain: rows[0].domain,
//         smtp_host: rows[0].smtp_host,
//         smtp_port: rows[0].smtp_port,
//         imap_host: rows[0].imap_host,
//         imap_port: rows[0].imap_port,
//       });
//     }

//     return res.status(404).json({
//       success: false,
//       message: 'Provider not identified. Please enter SMTP/IMAP details manually.',
//     });
//   } catch (error) {
//     console.error('Autodiscovery Error:', error);
//     res.status(500).json({ success: false, message: 'Server error' });
//   }
// });

// // ------------------------------------------------------------
// // 2) ADD PROVIDER
// // POST /api/email-configurations/providers
// // ------------------------------------------------------------
// router.post('/api/email-configurations/providers', async (req, res) => {
//   const pool = req.app.get('pool');
//   try {
//     const { provider, domain, smtp_host, smtp_port, imap_host, imap_port } = req.body;

//     if (!provider || !domain || !smtp_host || !smtp_port || !imap_host || !imap_port) {
//       return res.status(400).json({
//         success: false,
//         message: 'provider, domain, smtp_host, smtp_port, imap_host, imap_port are all required.',
//       });
//     }

//     await pool.execute(
//       `INSERT INTO email_provider_configurations
//          (provider, domain, smtp_host, smtp_port, imap_host, imap_port)
//        VALUES (?, ?, ?, ?, ?, ?)
//        ON DUPLICATE KEY UPDATE
//          smtp_host = VALUES(smtp_host),
//          smtp_port = VALUES(smtp_port),
//          imap_host = VALUES(imap_host),
//          imap_port = VALUES(imap_port)`,
//       [provider, domain.toLowerCase(), smtp_host, Number(smtp_port), imap_host, Number(imap_port)]
//     );

//     res.json({ success: true, message: 'Provider configuration saved.' });
//   } catch (error) {
//     console.error('Add Provider Error:', error);
//     res.status(500).json({ success: false, message: 'Server error' });
//   }
// });

// // ------------------------------------------------------------
// // 3) LIST PROVIDERS
// // GET /api/email-configurations/providers
// // ------------------------------------------------------------
// router.get('/api/email-configurations/providers', async (req, res) => {
//   const pool = req.app.get('pool');
//   try {
//     const [rows] = await pool.execute(
//       `SELECT id, provider, domain, smtp_host, smtp_port, imap_host, imap_port
//        FROM email_provider_configurations
//        ORDER BY provider ASC`
//     );
//     res.json({ success: true, data: rows });
//   } catch (error) {
//     console.error('List Providers Error:', error);
//     res.status(500).json({ success: false, message: 'Server error' });
//   }
// });

// ------------------------------------------------------------
// 4) EXISTING ROUTES — keep below the ones above
// ------------------------------------------------------------

// GET /api/email-configurations/:sellerId
router.get('/api/email-configurations/:sellerId', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const { sellerId } = req.params;

    const [rows] = await pool.execute(
      `SELECT ep.*, u.email_config, u.email_sent
       FROM email_profiles ep
       JOIN users u ON ep.seller_id = u.id
       WHERE ep.seller_id = ?
       LIMIT 1`,
      [sellerId]
    );

    if (rows.length === 0) {
      return res.json({ success: false, message: 'No configuration found' });
    }

    res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/email-configurations/:sellerId
router.put('/api/email-configurations/:sellerId', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const { sellerId } = req.params;
    const {
      profileName, provider, senderName, senderEmail,
      smtpHost, smtpPort, imapHost, imapPort,
      username, password, apiKey,
    } = req.body;

    if (!profileName || !provider || !senderEmail || !username) {
      return res.status(400).json({
        success: false,
        message: 'profileName, provider, senderEmail, and username are required.',
      });
    }

    const [existing] = await pool.execute(
      `SELECT id FROM email_profiles WHERE seller_id = ? LIMIT 1`,
      [sellerId]
    );

    if (existing.length > 0) {
      await pool.execute(
        `UPDATE email_profiles SET
           profile_name = ?, provider = ?, sender_name = ?, sender_email = ?,
           smtp_host = ?, smtp_port = ?, imap_host = ?, imap_port = ?,
           username = ?, password = ?, api_key = ?
         WHERE seller_id = ?`,
        [
          profileName, provider, senderName || null, senderEmail,
          smtpHost || null, smtpPort || null, imapHost || null, imapPort || null,
          username, password || null, apiKey || null, sellerId,
        ]
      );
    } else {
      await pool.execute(
        `INSERT INTO email_profiles
           (seller_id, profile_name, provider, sender_name, sender_email,
            smtp_host, smtp_port, imap_host, imap_port, username, password, api_key, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          sellerId, profileName, provider, senderName || null, senderEmail,
          smtpHost || null, smtpPort || null, imapHost || null, imapPort || null,
          username, password || null, apiKey || null,
        ]
      );
    }

    await pool.execute(`UPDATE users SET email_config = 1 WHERE id = ?`, [sellerId]);

    return res.status(200).json({
      success: true,
      message: 'Email configuration saved successfully.',
    });
  } catch (error) {
    console.error('Email Configuration Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal Server Error',
      error: error.message,
    });
  }
});

router.put('/api/send-test-email/:sellerId', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const { sellerId } = req.params;

    const [rows] = await pool.execute(
      `SELECT * FROM email_profiles WHERE seller_id = ? LIMIT 1`,
      [sellerId]
    );

    if (rows.length === 0) {
      return res.json({ success: false, message: 'Email configuration not found.' });
    }

    const config = rows[0];

    const transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: Number(config.smtp_port),
      secure: Number(config.smtp_port) === 465,
      auth: { user: config.username, pass: config.password },
      tls: { rejectUnauthorized: false },
    });

    await transporter.sendMail({
      from: `${config.sender_name} <${config.sender_email}>`,
      to: config.sender_email,
      subject: 'Test Email',
      html: `
        <h2>Email Configuration Successful</h2>
        <p>This is a test email.</p>
        <p>Your SMTP configuration is working correctly.</p>
      `,
    });

    await pool.execute(`UPDATE users SET email_sent = 1 WHERE id = ?`, [sellerId]);

    res.json({ success: true, message: 'Test email sent successfully.' });
  } catch (err) {
    console.log(err);
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;