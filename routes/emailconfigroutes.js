// routes/emailConfigRoutes.js
const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');

// GET /api/email-configurations/:sellerId - Get email configuration for a seller
router.get('/api/email-configurations/:sellerId', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const { sellerId } = req.params;

    const [rows] = await pool.execute(
      `
      SELECT
        ep.*,
        u.email_config,
        u.email_sent
      FROM email_profiles ep
      JOIN users u
        ON ep.seller_id = u.id
      WHERE ep.seller_id = ?
      LIMIT 1
      `,
      [sellerId]
    );

    if (rows.length === 0) {
      return res.json({
        success: false,
        message: "No configuration found",
      });
    }

    res.json({
      success: true,
      data: rows[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// PUT /api/email-configurations/:sellerId - Create or update email configuration
router.put('/api/email-configurations/:sellerId', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const { sellerId } = req.params;

    const {
      profileName,
      provider,
      senderName,
      senderEmail,
      smtpHost,
      smtpPort,
      imapHost,
      imapPort,
      username,
      password,
      apiKey,
    } = req.body;

    // Validation
    if (!profileName || !provider || !senderEmail || !username) {
      return res.status(400).json({
        success: false,
        message: "profileName, provider, senderEmail, and username are required.",
      });
    }

    // Check if email profile already exists
    const [existing] = await pool.execute(
      `SELECT id FROM email_profiles WHERE seller_id = ? LIMIT 1`,
      [sellerId]
    );

    if (existing.length > 0) {
      // Update existing profile
      await pool.execute(
        `
        UPDATE email_profiles
        SET
          profile_name = ?,
          provider = ?,
          sender_name = ?,
          sender_email = ?,
          smtp_host = ?,
          smtp_port = ?,
          imap_host = ?,
          imap_port = ?,
          username = ?,
          password = ?,
          api_key = ?
        WHERE seller_id = ?
        `,
        [
          profileName,
          provider,
          senderName || null,
          senderEmail,
          smtpHost || null,
          smtpPort || null,
          imapHost || null,
          imapPort || null,
          username,
          password || null,
          apiKey || null,
          sellerId,
        ]
      );
    } else {
      // Insert new profile
      await pool.execute(
        `
        INSERT INTO email_profiles
        (
          seller_id,
          profile_name,
          provider,
          sender_name,
          sender_email,
          smtp_host,
          smtp_port,
          imap_host,
          imap_port,
          username,
          password,
          api_key,
          is_active
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `,
        [
          sellerId,
          profileName,
          provider,
          senderName || null,
          senderEmail,
          smtpHost || null,
          smtpPort || null,
          imapHost || null,
          imapPort || null,
          username,
          password || null,
          apiKey || null,
        ]
      );
    }

    // Update users table
    await pool.execute(
      `
      UPDATE users
      SET email_config = 1
      WHERE id = ?
      `,
      [sellerId]
    );

    return res.status(200).json({
      success: true,
      message: "Email configuration saved successfully.",
    });

  } catch (error) {
    console.error("Email Configuration Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
});

// POST /api/send-test-email/:sellerId - Send test email using seller's configuration
router.post('/api/send-test-email/:sellerId', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const { sellerId } = req.params;

    const [rows] = await pool.execute(
      `
      SELECT *
      FROM email_profiles
      WHERE seller_id = ?
      LIMIT 1
      `,
      [sellerId]
    );

    if (rows.length === 0) {
      return res.json({
        success: false,
        message: "Email configuration not found."
      });
    }

    const config = rows[0];

    const transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: Number(config.smtp_port),
      secure: Number(config.smtp_port) === 465,
      auth: {
        user: config.username,
        pass: config.password
      },
      tls: {
        rejectUnauthorized: false
      }
    });

    await transporter.sendMail({
      from: `${config.sender_name} <${config.sender_email}>`,
      to: config.sender_email,
      subject: "Test Email",
      html: `
        <h2>Email Configuration Successful</h2>
        <p>This is a test email.</p>
        <p>Your SMTP configuration is working correctly.</p>
      `
    });

    await pool.execute(
      `
      UPDATE users
      SET email_sent = 1
      WHERE id = ?
      `,
      [sellerId]
    );

    res.json({
      success: true,
      message: "Test email sent successfully."
    });

  } catch (err) {
    console.log(err);
    res.json({
      success: false,
      message: err.message
    });
  }
});

module.exports = router;