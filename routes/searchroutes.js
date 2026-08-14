// routes/searchRoutes.js
const express = require('express');
const router = express.Router();
const pool = require("../db");

// Helper function to generate UUID
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Store response endpoint
router.post('/api/store-response', async (req, res) => {
  const pool = req.app.get('pool');
  const { 
    email, 
    response, 
    companyName, 
    country, 
    contactName, 
    productName,
    templateUsed,
    buyer_id,
    seller_id,
    hsn_code  
  } = req.body;

  // Validation
  if (!email || !response || !['interested', 'not_interested'].includes(response)) {
    return res.status(400).json({ 
      success: false, 
      error: 'Email and valid response (interested/not_interested) are required' 
    });
  }

  try {
    const batchId = generateUUID();
    const yourEmail = process.env.EMAIL_USER;
    
    const sellerId = seller_id || null;
    
    const [result] = await pool.query(
      `INSERT INTO email_history_companies 
        (batch_id, buyer_id, seller_id, company_name, country, contact_name, email, 
         response, responded_at, product_name, template_used, status,
         from_email, to_email, hsn_code) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, 'responded', ?, ?, ?)`,  
      [
        batchId,
        buyer_id || null,
        sellerId,
        companyName || null,
        country || null,
        contactName || null,
        email,
        response,
        productName || null,
        templateUsed || 'Manual Response',
        email,        
        yourEmail,
        hsn_code || null  
      ]
    );

    console.log('✅ New response stored:', {
      id: result.insertId,
      batchId,
      seller_id: sellerId,
      buyer_id: buyer_id,
      email,
      response,
      hsn_code: hsn_code || null, 
      from_email: email,
      to_email: yourEmail,
      timestamp: new Date().toISOString()
    });

    res.status(200).json({
      success: true,
      message: `${response === 'interested' ? 'Interested' : 'Not Interested'} response recorded successfully`,
      data: {
        id: result.insertId,
        batchId: batchId,
        seller_id: sellerId,
        buyer_id: buyer_id,
        email: email,
        response: response,
        hsn_code: hsn_code || null,  
        from_email: email,
        to_email: yourEmail,
        respondedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error storing response:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Reveal contact endpoint
router.post('/buyers/:id/reveal-contact', async (req, res) => {
  const pool = req.app.get('pool');
  const remotePool = req.app.get('remotePool');
  const conn = await pool.getConnection();
  
  try {
    const buyerId = Number(req.params.id);
    const seller_id = String(req.body.seller_id).trim();
    const { reveal_type } = req.body;

    if (!seller_id || isNaN(buyerId)) {
      return res.status(400).json({
        success: false,
        error: "seller_id and buyer id are required",
      });
    }
    if (!["phone", "email"].includes(reveal_type)) {
      return res.status(400).json({
        success: false,
        error: "reveal_type must be 'phone' or 'email'",
      });
    }

    await conn.beginTransaction();

    // Local: get seller's package_id, expiry, and current used counts
    const [sellerRows] = await conn.query(
      `SELECT
          id,
          package_id,
          package_expire,
          phone_used,
          email_used
       FROM users
       WHERE id = ?
       FOR UPDATE`,
      [seller_id]
    );

    if (sellerRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ success: false, error: "Seller not found" });
    }

    const seller = sellerRows[0];

    // Plan expiry check (local)
    if (!seller.package_expire || new Date(seller.package_expire) < new Date()) {
      await conn.rollback();
      return res.status(403).json({
        success: false,
        error: "PLAN_EXPIRED",
        message: "Your subscription plan has expired. Please renew to reveal contacts.",
      });
    }

    if (!seller.package_id) {
      await conn.rollback();
      return res.status(403).json({
        success: false,
        error: "NO_PACKAGE",
        message: "No active package assigned to this seller.",
      });
    }

    // Remote: fetch the buyer_contact_limit tied to this package
    const [pkgRows] = await remotePool.query(
      `SELECT buyer_contact_limit FROM tbl_package_membership WHERE id = ?`,
      [seller.package_id]
    );

    if (pkgRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({
        success: false,
        error: "PACKAGE_NOT_FOUND",
        message: "Package details not found.",
      });
    }

    const buyerContactLimit = pkgRows[0].buyer_contact_limit;
    const isUnlimited = buyerContactLimit === null || buyerContactLimit === undefined;

    // Already revealed?
    const [existing] = await conn.query(
      `SELECT 1 FROM contact_reveal_history
       WHERE seller_id = ? AND buyer_id = ? AND reveal_type = ?`,
      [seller_id, buyerId, reveal_type]
    );
    const alreadyRevealed = existing.length > 0;

    if (!alreadyRevealed) {
      const usedField = reveal_type === "phone" ? "phone_used" : "email_used";
      const used = seller[usedField];

      if (!isUnlimited && used >= buyerContactLimit) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          error: "LIMIT_REACHED",
          message: `You've reached your ${reveal_type} reveal limit (${used}/${buyerContactLimit}).`,
        });
      }

      await conn.query(
        `INSERT INTO contact_reveal_history (seller_id, buyer_id, reveal_type, revealed_at)
         VALUES (?, ?, ?, NOW())`,
        [seller_id, buyerId, reveal_type]
      );

      if (!isUnlimited) {
        await conn.query(
          `UPDATE users SET ${usedField} = ${usedField} + 1 WHERE id = ?`,
          [seller_id]
        );
      }
    }

    let data = {};
    if (reveal_type === "phone") {
      const [rows] = await conn.query(
        `SELECT GROUP_CONCAT(DISTINCT contact_number SEPARATOR ', ') AS contacts
         FROM buyer_contacts WHERE buyer_id = ?`,
        [buyerId]
      );
      data.contacts = rows[0]?.contacts || null;
    } else {
      const [rows] = await conn.query(
        `SELECT GROUP_CONCAT(DISTINCT email SEPARATOR ', ') AS emails
         FROM buyer_emails WHERE buyer_id = ?`,
        [buyerId]
      );
      data.emails = rows[0]?.emails || null;
    }

    await conn.commit();
    res.json({ success: true, data });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
});

// Get buyers with search/filter
router.get('/buyers', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const sellerId = Number(req.query.seller_id);
    const limit = Math.min(Number(req.query.limit || 50), 100);
    const offset = Number(req.query.offset || 0);
    const search = req.query.search || "";
    const country = req.query.country || "";
    const product = req.query.product || "";

    let where = [];
    let values = [];

    if (search) {
      where.push(`(
        b.company_name LIKE ? OR b.country LIKE ? OR b.product LIKE ?
        OR b.hsn_code LIKE ? OR b.website LIKE ?
      )`);
      values.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (country) { where.push("b.country = ?"); values.push(country); }
    if (product) { where.push("b.product = ?"); values.push(product); }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    // Get total count for pagination UI
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM buyers b ${whereClause}`,
      values
    );
    const total = countRows[0].total;

    const sql = `
      SELECT
        b.id AS buyer_id, b.buyer_date, b.product, b.hsn_code, b.country,
        b.company_name, b.website,
        EXISTS(
          SELECT 1 FROM contact_reveal_history
          WHERE seller_id = ? AND buyer_id = b.id AND reveal_type = 'phone'
        ) AS phone_revealed,
        EXISTS(
          SELECT 1 FROM contact_reveal_history
          WHERE seller_id = ? AND buyer_id = b.id AND reveal_type = 'email'
        ) AS email_revealed
      FROM buyers b
      ${whereClause}
      ORDER BY b.id DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await pool.query(sql, [sellerId, sellerId, ...values, limit, offset]);

    const revealedPhoneIds = rows.filter(r => r.phone_revealed).map(r => r.buyer_id);
    const revealedEmailIds = rows.filter(r => r.email_revealed).map(r => r.buyer_id);

    let contactsMap = {};
    let emailsMap = {};

    if (revealedPhoneIds.length) {
      const [contactRows] = await pool.query(
        `SELECT buyer_id, GROUP_CONCAT(DISTINCT contact_number SEPARATOR ', ') AS contacts
         FROM buyer_contacts WHERE buyer_id IN (?) GROUP BY buyer_id`,
        [revealedPhoneIds]
      );
      contactsMap = Object.fromEntries(contactRows.map(r => [r.buyer_id, r.contacts]));
    }

    if (revealedEmailIds.length) {
      const [emailRows] = await pool.query(
        `SELECT buyer_id, GROUP_CONCAT(DISTINCT email SEPARATOR ', ') AS emails
         FROM buyer_emails WHERE buyer_id IN (?) GROUP BY buyer_id`,
        [revealedEmailIds]
      );
      emailsMap = Object.fromEntries(emailRows.map(r => [r.buyer_id, r.emails]));
    }

    const data = rows.map(r => ({
      ...r,
      contacts: r.phone_revealed ? (contactsMap[r.buyer_id] || null) : null,
      emails: r.email_revealed ? (emailsMap[r.buyer_id] || null) : null,
    }));

    res.json({
      success: true,
      data,
      total,          // <-- frontend needs this
      offset,
      limit,
      has_more: offset + rows.length < total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get buyer countries filter
router.get("/filters/buyer-countries", async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const [rows] = await pool.query(`
      SELECT DISTINCT country FROM buyers
      WHERE country IS NOT NULL AND country <> ''
      ORDER BY country
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get products filter
router.get("/filters/products", async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const [rows] = await pool.query(`
      SELECT DISTINCT product FROM buyers
      WHERE product IS NOT NULL AND product <> ''
      ORDER BY product
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single buyer details
router.get("/buyers/:id", async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const buyerId = Number(req.params.id);
    const sellerId = Number(req.query.seller_id);

    // Step 1: fetch buyer + reveal status ONLY — no contact/email tables touched
    const [buyerRows] = await pool.query(
      `SELECT b.*,
         EXISTS(
           SELECT 1 FROM contact_reveal_history
           WHERE seller_id = ? AND buyer_id = b.id AND reveal_type = 'phone'
         ) AS phone_revealed,
         EXISTS(
           SELECT 1 FROM contact_reveal_history
           WHERE seller_id = ? AND buyer_id = b.id AND reveal_type = 'email'
         ) AS email_revealed
       FROM buyers b
       WHERE b.id = ?`,
      [sellerId, sellerId, buyerId]
    );

    if (buyerRows.length === 0) {
      return res.status(404).json({ success: false, error: "Buyer not found" });
    }

    const buyer = buyerRows[0];

    // Step 2: only query real contact/email data if it was actually revealed
    if (buyer.phone_revealed) {
      const [contactRows] = await pool.query(
        `SELECT GROUP_CONCAT(DISTINCT contact_number SEPARATOR ', ') AS contacts
         FROM buyer_contacts WHERE buyer_id = ?`,
        [buyerId]
      );
      buyer.contacts = contactRows[0]?.contacts || null;
    } else {
      buyer.contacts = null; // frontend shows lock icon instead
    }

    if (buyer.email_revealed) {
      const [emailRows] = await pool.query(
        `SELECT GROUP_CONCAT(DISTINCT email SEPARATOR ', ') AS emails
         FROM buyer_emails WHERE buyer_id = ?`,
        [buyerId]
      );
      buyer.emails = emailRows[0]?.emails || null;
    } else {
      buyer.emails = null;
    }

    res.json({ success: true, data: buyer });
  } catch (err) {
    console.error("GET /buyers/:id ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;