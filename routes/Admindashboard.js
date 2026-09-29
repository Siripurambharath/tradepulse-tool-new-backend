// routes/buyerroutes.js
const express = require('express');
const router = express.Router();

// ══════════════════════════════════════════════
// GET /buyersnew  (paginated list)
// ══════════════════════════════════════════════
router.get('/buyersnew', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const rawSeller = req.query.seller_id;
    const parsedSeller = Number(rawSeller);
    const sellerId =
      rawSeller !== undefined && rawSeller !== '' &&
      Number.isFinite(parsedSeller) && parsedSeller > 0
        ? parsedSeller : null;

    const limit  = Math.min(Number(req.query.limit  || 50), 100);
    const offset = Number(req.query.offset || 0);
    const search  = (req.query.search  || "").trim();
    const country = (req.query.country || "").trim();
    const product = (req.query.product || "").trim();

    let where = [];
    let values = [];

    if (search) {
      const like = `${search}%`;
      where.push(`(
        b.company_name LIKE ? OR b.country LIKE ? OR b.product LIKE ?
        OR b.hsn_code LIKE ? OR b.website LIKE ?
        OR EXISTS (SELECT 1 FROM buyer_emails  be WHERE be.buyer_id = b.id AND be.email          LIKE ?)
        OR EXISTS (SELECT 1 FROM buyer_contacts bc WHERE bc.buyer_id = b.id AND bc.contact_number LIKE ?)
      )`);
      values.push(like, like, like, like, like, like, like);
    }
    if (country) { where.push("b.country = ?"); values.push(country); }
    if (product) { where.push("b.product = ?"); values.push(product); }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    let total;
    if (offset === 0) {
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total FROM buyers b ${whereClause}`, values
      );
      total = countRows[0].total;
    } else {
      total = 0;
    }

    let rows;

    if (sellerId !== null) {
      const sql = `
        SELECT
          b.id AS id, b.created_at, b.buyer_date, b.product, b.hsn_code, b.country,
          b.company_name, b.website,
          MAX(CASE WHEN crh.reveal_type = 'phone' THEN 1 ELSE 0 END) AS phone_revealed,
          MAX(CASE WHEN crh.reveal_type = 'email' THEN 1 ELSE 0 END) AS email_revealed
        FROM buyers b
        LEFT JOIN contact_reveal_history crh
          ON crh.buyer_id = b.id AND crh.seller_id = ?
        ${whereClause}
        GROUP BY b.id
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT ? OFFSET ?
      `;
      [rows] = await pool.query(sql, [sellerId, ...values, limit, offset]);
    } else {
      const sql = `
        SELECT
          b.id AS id, b.created_at, b.buyer_date, b.product, b.hsn_code, b.country,
          b.company_name, b.website,
          1 AS phone_revealed, 1 AS email_revealed
        FROM buyers b
        ${whereClause}
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT ? OFFSET ?
      `;
      [rows] = await pool.query(sql, [...values, limit, offset]);
    }

    const revealedPhoneIds = rows.filter(r => r.phone_revealed).map(r => r.id);
    const revealedEmailIds = rows.filter(r => r.email_revealed).map(r => r.id);

    const [contactsRes, emailsRes] = await Promise.all([
      revealedPhoneIds.length
        ? pool.query(
            `SELECT buyer_id, GROUP_CONCAT(DISTINCT contact_number SEPARATOR ', ') AS contacts
             FROM buyer_contacts WHERE buyer_id IN (?) GROUP BY buyer_id`,
            [revealedPhoneIds])
        : Promise.resolve([[]]),
      revealedEmailIds.length
        ? pool.query(
            `SELECT buyer_id, GROUP_CONCAT(DISTINCT email SEPARATOR ', ') AS emails
             FROM buyer_emails WHERE buyer_id IN (?) GROUP BY buyer_id`,
            [revealedEmailIds])
        : Promise.resolve([[]]),
    ]);

    const contactsMap = Object.fromEntries(contactsRes[0].map(r => [r.buyer_id, r.contacts]));
    const emailsMap   = Object.fromEntries(emailsRes[0].map(r   => [r.buyer_id, r.emails]));

    const data = rows.map(r => ({
      ...r,
      contacts: r.phone_revealed ? (contactsMap[r.id] || null) : null,
      emails:   r.email_revealed ? (emailsMap[r.id]   || null) : null,
    }));

    res.json({
      success: true, data, total, offset, limit,
      has_more: offset + rows.length < total,
    });
  } catch (err) {
    console.error('GET /buyersnew error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════
// GET /buyers/latest
// ══════════════════════════════════════════════
router.get('/buyers/latest', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const limit = Math.min(Number(req.query.limit || 5), 20);

    const [rows] = await pool.query(
      `SELECT b.id, b.company_name, b.product, b.hsn_code, b.country, b.created_at, b.buyer_date
       FROM buyers b
       ORDER BY b.created_at DESC, b.id DESC
       LIMIT ?`,
      [limit]
    );

    const ids = rows.map(r => r.id);
    if (!ids.length) return res.json({ success: true, data: [] });

    const [contactsRes, emailsRes] = await Promise.all([
      pool.query(
        `SELECT buyer_id, GROUP_CONCAT(DISTINCT contact_number SEPARATOR ', ') AS contacts
         FROM buyer_contacts WHERE buyer_id IN (?) GROUP BY buyer_id`,
        [ids]
      ),
      pool.query(
        `SELECT buyer_id, GROUP_CONCAT(DISTINCT email SEPARATOR ', ') AS emails
         FROM buyer_emails WHERE buyer_id IN (?) GROUP BY buyer_id`,
        [ids]
      ),
    ]);

    const contactsMap = Object.fromEntries(contactsRes[0].map(r => [r.buyer_id, r.contacts]));
    const emailsMap   = Object.fromEntries(emailsRes[0].map(r   => [r.buyer_id, r.emails]));

    const data = rows.map(r => ({
      ...r,
      contacts: contactsMap[r.id] || null,
      emails:   emailsMap[r.id]   || null,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /buyers/latest error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════
// GET /buyers/count
// ══════════════════════════════════════════════
router.get('/buyers/count', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const search  = req.query.search  || "";
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

    const [rows] = await pool.query(
      `SELECT COUNT(*) AS total FROM buyers b ${whereClause}`, values
    );

    res.json({ success: true, total: rows[0].total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════
// GET /buyers/:id
// ══════════════════════════════════════════════
router.get('/buyers/:id', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const buyerId = Number(req.params.id);
    if (!buyerId) return res.status(400).json({ success: false, error: 'Invalid buyer id' });

    const [[buyer]] = await pool.query(
      `SELECT * FROM buyers WHERE id = ? LIMIT 1`, [buyerId]
    );
    if (!buyer) return res.status(404).json({ success: false, error: 'Buyer not found' });

    const [contacts] = await pool.query(
      `SELECT id, contact_number FROM buyer_contacts WHERE buyer_id = ?`, [buyerId]
    );
    const [emails] = await pool.query(
      `SELECT id, email FROM buyer_emails WHERE buyer_id = ?`, [buyerId]
    );

    res.json({ success: true, data: { ...buyer, contacts, emails } });
  } catch (err) {
    console.error('GET /buyers/:id error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════
// PUT /buyers/:id
// ══════════════════════════════════════════════
router.put('/buyers/:id', async (req, res) => {
  const pool = req.app.get('pool');
  const conn = await pool.getConnection();
  try {
    const buyerId = Number(req.params.id);
    if (!buyerId) return res.status(400).json({ success: false, error: 'Invalid buyer id' });

    const {
      product, hsn_code, country, company_name, website, address,
      additional_details, suggested_keywords, hsn_descriptions,
      confidence_level, reason, classification_notes,
      manual_verification, buyer_date,
      contacts = [], emails = [],
    } = req.body;

    await conn.beginTransaction();

    const [updateResult] = await conn.query(
      `UPDATE buyers SET
         product = ?, hsn_code = ?, country = ?, company_name = ?, website = ?,
         address = ?, additional_details = ?, suggested_keywords = ?,
         hsn_descriptions = ?, confidence_level = ?, reason = ?,
         classification_notes = ?, manual_verification = ?, buyer_date = ?
       WHERE id = ?`,
      [
        product ?? null, hsn_code ?? null, country ?? null, company_name ?? null,
        website ?? null, address ?? null, additional_details ?? null,
        suggested_keywords ?? null, hsn_descriptions ?? null, confidence_level ?? null,
        reason ?? null, classification_notes ?? null, manual_verification ?? null,
        buyer_date ?? null, buyerId,
      ]
    );

    if (updateResult.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ success: false, error: 'Buyer not found' });
    }

    if (Array.isArray(contacts)) {
      await conn.query(`DELETE FROM buyer_contacts WHERE buyer_id = ?`, [buyerId]);
      const cleaned = contacts.map((c) => (c || '').trim()).filter(Boolean);
      if (cleaned.length) {
        await conn.query(
          `INSERT INTO buyer_contacts (buyer_id, contact_number) VALUES ?`,
          [cleaned.map((c) => [buyerId, c])]
        );
      }
    }

    if (Array.isArray(emails)) {
      await conn.query(`DELETE FROM buyer_emails WHERE buyer_id = ?`, [buyerId]);
      const cleaned = emails.map((e) => (e || '').trim()).filter(Boolean);
      if (cleaned.length) {
        await conn.query(
          `INSERT INTO buyer_emails (buyer_id, email) VALUES ?`,
          [cleaned.map((e) => [buyerId, e])]
        );
      }
    }

    await conn.commit();
    res.json({ success: true, message: 'Buyer updated successfully' });
  } catch (err) {
    await conn.rollback();
    console.error('PUT /buyers/:id error', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
});

// ══════════════════════════════════════════════
// DELETE /buyers/:id
// ══════════════════════════════════════════════
router.delete('/buyers/:id', async (req, res) => {
  const pool = req.app.get('pool');
  const conn = await pool.getConnection();
  try {
    const buyerId = Number(req.params.id);
    if (!buyerId) return res.status(400).json({ success: false, error: 'Invalid buyer id' });

    await conn.beginTransaction();
    await conn.query(`DELETE FROM buyer_contacts WHERE buyer_id = ?`, [buyerId]);
    await conn.query(`DELETE FROM buyer_emails WHERE buyer_id = ?`, [buyerId]);
    const [result] = await conn.query(`DELETE FROM buyers WHERE id = ?`, [buyerId]);

    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ success: false, error: 'Buyer not found' });
    }

    await conn.commit();
    res.json({ success: true, message: 'Buyer deleted successfully' });
  } catch (err) {
    await conn.rollback();
    console.error('DELETE /buyers/:id error', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
});

// ══════════════════════════════════════════════
// GET /dashboard/buyers-analytics
// ══════════════════════════════════════════════
router.get('/dashboard/buyers-analytics', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const search  = (req.query.search  || "").trim();
    const country = (req.query.country || "").trim();
    const product = (req.query.product || "").trim();
    const year    = req.query.year || "";
    const from    = req.query.from || "";
    const to      = req.query.to   || "";

    let where = [];
    let values = [];

    if (year && /^\d{4}$/.test(String(year))) {
      where.push("b.buyer_date >= ? AND b.buyer_date < ?");
      values.push(`${year}-01-01`, `${Number(year) + 1}-01-01`);
    } else if (from && to) {
      where.push("b.buyer_date >= ? AND b.buyer_date <= ?");
      values.push(from, to);
    } else if (from) {
      where.push("b.buyer_date >= ?"); values.push(from);
    } else if (to) {
      where.push("b.buyer_date <= ?"); values.push(to);
    }

    if (search) {
      const like = `${search}%`;
      where.push(`(
        b.company_name LIKE ? OR b.country LIKE ? OR b.product LIKE ?
        OR b.hsn_code LIKE ? OR b.website LIKE ?
      )`);
      values.push(like, like, like, like, like);
    }
    if (country) { where.push("b.country = ?"); values.push(country); }
    if (product) { where.push("b.product = ?"); values.push(product); }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [
      [totalsRows],
      [monthlyRows],
      [productShareRows],
      [countryShareRows],
    ] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total_buyers FROM buyers b ${whereClause}`, values),
      pool.query(
        `SELECT DATE_FORMAT(b.buyer_date, '%b') AS month,
                MONTH(b.buyer_date) AS month_num,
                COUNT(*) AS buyers
         FROM buyers b ${whereClause}
         GROUP BY MONTH(b.buyer_date), DATE_FORMAT(b.buyer_date, '%b')
         ORDER BY month_num`, values),
      pool.query(
        `SELECT COALESCE(NULLIF(b.product,''),'Others') AS name, COUNT(*) AS value
         FROM buyers b ${whereClause}
         GROUP BY name ORDER BY value DESC LIMIT 5`, values),
      pool.query(
        `SELECT COALESCE(NULLIF(b.country,''),'Unknown') AS name, COUNT(*) AS value
         FROM buyers b ${whereClause}
         GROUP BY name ORDER BY value DESC LIMIT 5`, values),
    ]);

    const totalBuyers = totalsRows[0].total_buyers;
    const monthCount  = monthlyRows.length || 1;

    res.json({
      success: true,
      filters: { search, country, product, year, from, to },
      totals: {
        total_buyers: totalBuyers,
        avg_buyers_per_month: Math.round(totalBuyers / monthCount),
      },
      monthly: monthlyRows.map(r => ({ month: r.month, buyers: r.buyers })),
      product_share: productShareRows,
      country_share: countryShareRows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════
// GET /users/stats  (AdminDashboard)
// ══════════════════════════════════════════════
router.get('/users/stats', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const [[totals]] = await pool.query(`
      SELECT
        COUNT(*)                                          AS total_users,
        SUM(CASE WHEN email_sent   = 1 THEN 1 ELSE 0 END) AS email_sent_count,
        SUM(CASE WHEN email_config = 1 THEN 1 ELSE 0 END) AS email_config_count
      FROM users
    `);

    const [roleRows] = await pool.query(`
      SELECT role, COUNT(*) AS count
      FROM users
      GROUP BY role
    `);

    const roleBreakdown = roleRows.reduce((acc, r) => {
      acc[r.role] = r.count;
      return acc;
    }, {});

    res.json({
      success: true,
      total_users: Number(totals.total_users) || 0,
      email_sent_count: Number(totals.email_sent_count) || 0,
      email_config_count: Number(totals.email_config_count) || 0,
      role_breakdown: roleBreakdown,
    });
  } catch (error) {
    console.error("Error fetching user stats:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch user stats",
      error: error.message,
    });
  }
});

// ══════════════════════════════════════════════
// GET /filters/products  +  /filters/buyer-countries
// (AdminDashboard uses these dropdowns)
// ══════════════════════════════════════════════
router.get('/filters/products', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT product FROM buyers WHERE product IS NOT NULL AND product <> '' ORDER BY product`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /filters/products error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/filters/buyer-countries', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT country FROM buyers WHERE country IS NOT NULL AND country <> '' ORDER BY country`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /filters/buyer-countries error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;