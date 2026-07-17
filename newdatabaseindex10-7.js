const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
// const session = require('express-session');

const nodemailer = require('nodemailer');
const Bull = require('bull');
const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { checkForReplies } = require('./readReplies');
const jwt = require("jsonwebtoken");
require('dotenv').config();
const buyerRoutes = require('./routes/buyerRoutes');
// const ssoRouter = require('./routes/ssoRoute');

const bulkBuyerRoutes = require('./routes/bulkBuyerRoutes'); 
const userRoutes = require('./routes/UsersRoutes');
const app = express();

app.use(cors());
app.use(express.json());



// app.use(session({
//   secret: process.env.SESSION_SECRET || 'replace-with-a-strong-random-secret',
//   resave: false,
//   saveUninitialized: false,
//   cookie: {
//     secure: true,       // requires HTTPS — needed since you're cross-domain
//     httpOnly: true,
//     sameSite: 'none',   // required for cross-domain cookies to be sent/set
//     maxAge: 24 * 60 * 60 * 1000, // 1 day, adjust as needed
//   },
// }));
/* ─────────────────────────────────────────────
   MYSQL
───────────────────────────────────────────── */

const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "seller_buyer_dummy",
  waitForConnections: true,
  connectionLimit: 20,
});


const remotePool = mysql.createPool({
  host: "89.116.20.241", 
  user: "b2buser",
  password: "5-kFm?qpumuZWTwk9lXa",
  database: "b2b",
  waitForConnections: true,
  connectionLimit: 5,
});

app.set('remotePool', remotePool);
app.set('pool', pool);
/* ─────────────────────────────────────────────
   FETCH EMAIL PROFILE BY SELLER ID
───────────────────────────────────────────── */

async function getEmailProfileBySellerId(sellerId) {
  const [rows] = await pool.query(
    `SELECT * FROM email_profiles 
     WHERE seller_id = ? AND is_active = 1 
     ORDER BY id DESC 
     LIMIT 1`,
    [sellerId]
  );
  if (!rows.length) {
    throw new Error(`No active email profile found for seller_id: ${sellerId}`);
  }
  return rows[0];
}

/* ─────────────────────────────────────────────
   CREATE TRANSPORTER FROM PROFILE
───────────────────────────────────────────── */

function createTransporterFromProfile(profile) {
  if (profile.api_key) {
    return nodemailer.createTransport({
      host: profile.smtp_host || 'smtp.sendgrid.net',
      port: profile.smtp_port || 587,
      secure: false,
      auth: {
        user: 'apikey',
        pass: profile.api_key,
      },
      tls: { rejectUnauthorized: false },
    });
  }

  return nodemailer.createTransport({
    host: profile.smtp_host,
    port: profile.smtp_port || 587,
    secure: profile.smtp_port === 465,
    auth: {
      user: profile.username,
      pass: profile.password,
    },
    tls: { rejectUnauthorized: false },
  });
}

/* ─────────────────────────────────────────────
   TRANSPORTER CACHE (avoid rebuilding per job)
───────────────────────────────────────────── */

const transporterCache = new Map(); // profileId -> transporter

function getCachedTransporter(profile) {
  if (transporterCache.has(profile.id)) {
    return transporterCache.get(profile.id);
  }
  const transporter = createTransporterFromProfile(profile);
  transporterCache.set(profile.id, transporter);
  return transporter;
}

/* ─────────────────────────────────────────────
   BULL QUEUE & EMAIL SETUP
───────────────────────────────────────────── */

const emailQueue = new Bull('email-queue', {
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
  },
  limiter: {
    max: 20,
    duration: 60000,
  },
});

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({ queues: [new BullAdapter(emailQueue)], serverAdapter });
app.use('/admin/queues', serverAdapter.getRouter());

function buildHtml(message, product, interestedUrl, notInterestedUrl) {
  return `
    <!DOCTYPE html><html><head><style>
      body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
      .container { max-width: 600px; margin: 0 auto; padding: 20px; }
      .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; }
      .content { padding: 20px; background-color: #f9fafb; }
      .footer { padding: 20px; text-align: center; font-size: 12px; color: #6b7280; }
      .product { font-weight: bold; color: #4F46E5; }
      .btn-row { margin-top: 24px; }
      .btn {
        display: inline-block;
        padding: 12px 28px;
        border-radius: 6px;
        text-decoration: none;
        font-weight: bold;
        font-size: 15px;
        margin-right: 12px;
      }
      .btn-yes { background-color: #22c55e; color: white; }
      .btn-no  { background-color: #ef4444; color: white; }
      .note { font-size: 12px; color: #9ca3af; margin-top: 16px; }
    </style></head><body>
      <div class="container">
        <div class="header"><h2>Business Opportunity</h2></div>
        <div class="content">
          ${message.replace(/\n/g, '<br/>')}
          <br/><br/>
          <p>Product/Service: <span class="product">${product}</span></p>
          <p><strong>Are you interested in this product?</strong></p>
          <div class="btn-row">
            <a href="${interestedUrl}" class="btn btn-yes">✅ Interested</a>
            <a href="${notInterestedUrl}" class="btn btn-no">❌ Not Interested</a>
          </div>
          <p class="note">Clicking a button records your response. You can only respond once.</p>
          <br/>
          <p>Best regards,<br/>Trade Platform Team</p>
        </div>
        <div class="footer">
          <p>This is an automated message from Trade Platform.</p>
        </div>
      </div>
    </body></html>
  `;
}

/* ─────────────────────────────────────────────
   QUEUE PROCESSOR — uses per-job email profile
───────────────────────────────────────────── */
emailQueue.process(async (job) => {
  const {
    recipientEmail,
    subject,
    message,
    product,
    originalProduct,
    company,
    batchId,
    sellerId,
    emailProfile,
  } = job.data;

  console.log(`Processing job for ${recipientEmail} in batch ${batchId} via profile ${emailProfile?.profile_name} (seller_id=${sellerId})`);
  console.log(`📞 Contact Number: ${company.contacts || 'Not provided'}`);

  await job.progress(20);

  const trackedSubject = `${subject || `Business Opportunity - ${product}`} [BATCH:${batchId}]`;

  let sendStatus = 'Sent';
  let sendError = null;
  let messageId = null;

  try {
    if (!emailProfile) {
      throw new Error('No email profile attached to job');
    }

    const transporter = getCachedTransporter(emailProfile);

    const BASE_URL = process.env.BASE_URL;
    const interestedUrl    = `${BASE_URL}/track-response?batchId=${batchId}&email=${encodeURIComponent(recipientEmail)}&response=interested`;
    const notInterestedUrl = `${BASE_URL}/track-response?batchId=${batchId}&email=${encodeURIComponent(recipientEmail)}&response=not_interested`;

    const info = await transporter.sendMail({
      from: `"${emailProfile.sender_name}" <${emailProfile.sender_email}>`,
      to: recipientEmail,
      subject: trackedSubject,
      html: buildHtml(message, originalProduct, interestedUrl, notInterestedUrl),
      headers: {
        'X-Batch-ID': batchId,
        'X-Product': product,
        'Message-ID': `<${batchId}-${Date.now()}@yourdomain.com>`,
      },
    });

    messageId = info.messageId;
    console.log(`✅ Sent to ${recipientEmail} via ${emailProfile.sender_email} [${messageId}]`);
    await job.progress(70);

  } catch (err) {
    console.error(`❌ Failed to send to ${recipientEmail}:`, err.message);
    sendStatus = 'Failed';
    sendError = err;
    await job.progress(70);
  }

  try {
    const [existing] = await pool.query(
      `SELECT id FROM email_history_companies 
       WHERE batch_id = ? AND email = ?`,
      [batchId, recipientEmail]
    );

    // Store contacts in contact_name column
    const contactValue = company.contacts || company.contact_number || company.contactName || company.companyName || 'Unknown';

    if (existing.length > 0) {
      await pool.query(
        `UPDATE email_history_companies 
         SET sent_at = ?, status = ?, template_used = ?, template_id = ?, 
             product_name = ?, multiple_products = ?, buyer_id = ?, seller_id = ?,
             contact_name = ?
         WHERE batch_id = ? AND email = ?`,
        [new Date(), sendStatus, company.templateUsed || 'Welcome Template',
         company.templateId, originalProduct, job.data.multipleProducts || false,
         company.buyer_id, sellerId, 
         contactValue,  // Store contacts in contact_name
         batchId, recipientEmail]
      );
    } else {
      await pool.query(
        `INSERT INTO email_history_companies
          (batch_id, seller_id, buyer_id, company_name, country, contact_name, email, 
           sent_at, status, template_used, template_id, product_name, multiple_products)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [batchId, sellerId, company.buyer_id, company.companyName || 'Unknown',
         company.country || null, 
         contactValue,  // Store contacts in contact_name
         recipientEmail, new Date(), sendStatus, company.templateUsed || 'Welcome Template',
         company.templateId, originalProduct, job.data.multipleProducts || false]
      );
    }
    
    console.log(`💾 Stored contact in contact_name: ${contactValue}`);

  } catch (dbErr) {
    console.error(`💾 Database error for ${recipientEmail}:`, dbErr.message);
  }

  if (sendError) throw sendError;

  return { recipientEmail, status: sendStatus, messageId };
});

emailQueue.on('completed', (job, result) => {
  console.log(`Job ${job.id} completed — ${result.recipientEmail} [${result.status}]`);
});
emailQueue.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed — ${job.data.recipientEmail}: ${err.message}`);
});

app.post('/send-email', async (req, res) => {
  const { product, subject, message, historyPayload, seller_id } = req.body;

  console.log('═══════════════════════════════════════');
  console.log('📧 SEND EMAIL API - FULL REQUEST BODY');
  console.log('═══════════════════════════════════════');
  console.log(JSON.stringify(req.body, null, 2));

  if (!seller_id) {
    return res.status(400).json({ error: 'seller_id is required' });
  }

  if (!historyPayload) {
    return res.status(400).json({ error: 'historyPayload is required' });
  }

  const { id: batchId, companies } = historyPayload;

  if (!batchId) {
    return res.status(400).json({ error: 'historyPayload.id (batchId) is required' });
  }

  if (!companies || companies.length === 0) {
    return res.status(400).json({ error: 'No recipients specified' });
  }

  // Fetch the seller's active email profile BEFORE enqueuing
  let emailProfile;
  try {
    emailProfile = await getEmailProfileBySellerId(seller_id);
    console.log(`📨 Using email profile: ${emailProfile.profile_name} (${emailProfile.sender_email})`);
  } catch (err) {
    console.error('Email profile fetch error:', err.message);
    return res.status(404).json({ error: err.message });
  }

  try {
    const jobs = await Promise.all(
      companies.map((company, index) =>
        emailQueue.add(
          {
            recipientEmail: company.email,
            subject,
            message,
            product: product,
            originalProduct: company.product,
            company: {
              ...company,
              buyer_id: company.buyer_id,
              templateId: company.templateId,
              contacts: company.contacts || company.contact_number || '',  // Pass contacts
              contactName: company.contactName || company.contacts || company.companyName || 'Unknown',  // Also pass contactName
            },
            batchId,
            sellerId: seller_id,
            multipleProducts: req.body.multipleProducts || false,
            emailProfile,
          },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 3000 },
            removeOnComplete: false,
            removeOnFail: false,
            jobId: `${batchId}-${index}`,
          }
        )
      )
    );

    const jobIds = jobs.map((j) => j.id.toString());
    console.log(`Enqueued ${jobIds.length} jobs for batch ${batchId} using seller ${seller_id}`);
    console.log(`📞 Contacts passed: ${companies.map(c => c.contacts).join(', ')}`);
    res.json({ batchId, jobIds, total: jobIds.length });

  } catch (err) {
    console.error('Queue error:', err);
    res.status(500).json({ error: 'Failed to enqueue jobs', details: err.message });
  }
});

/* ─────────────────────────────────────────────
   BATCH STATUS
───────────────────────────────────────────── */

app.get('/batch-status/:batchId', async (req, res) => {
  const jobIdsParam = req.query.jobIds;
  if (!jobIdsParam) {
    return res.status(400).json({ error: 'jobIds query param required' });
  }

  const jobIds = jobIdsParam.split(',');

  try {
    const jobStatuses = await Promise.all(
      jobIds.map(async (jobId) => {
        const job = await emailQueue.getJob(jobId);
        if (!job) return { jobId, state: 'not_found', progress: 0, email: null };

        const state = await job.getState();
        return {
          jobId,
          email: job.data.recipientEmail,
          companyName: job.data.company?.companyName,
          state,
          progress: job._progress || 0,
          result: state === 'completed' ? job.returnvalue : null,
          reason: state === 'failed' ? job.failedReason : null,
        };
      })
    );

    const total = jobStatuses.length;
    const completed = jobStatuses.filter((j) => j.state === 'completed').length;
    const failed = jobStatuses.filter((j) => j.state === 'failed').length;
    const active = jobStatuses.filter((j) => j.state === 'active').length;
    const waiting = jobStatuses.filter((j) => ['waiting', 'delayed'].includes(j.state)).length;

    res.json({
      batchId: req.params.batchId,
      total,
      completed,
      failed,
      active,
      waiting,
      allDone: completed + failed === total,
      overallProgress: total > 0 ? Math.round(((completed + failed) / total) * 100) : 0,
      jobs: jobStatuses,
    });

  } catch (err) {
    console.error('Batch status error:', err);
    res.status(500).json({ error: 'Failed to get batch status' });
  }
});

/* ─────────────────────────────────────────────
   BUYERS / FILTERS / TEMPLATES
───────────────────────────────────────────── */


app.post("/buyers/:id/reveal-contact", async (req, res) => {
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
    // NULL (or missing) buyer_contact_limit means Unlimited
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
app.get("/buyers", async (req, res) => {
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





app.get("/filters/buyer-countries", async (req, res) => {
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

app.get("/filters/products", async (req, res) => {
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
app.get("/buyers/:id", async (req, res) => {
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

// ==================== ULTRA-FAST HISTORY LIST API ====================
app.get('/history', async (req, res) => {
  const { 
    seller_id, 
    page = 1, 
    limit = 10, 
    search = '', 
    product = '' 
  } = req.query;

  if (!seller_id) {
    return res.status(400).json({ error: 'seller_id is required' });
  }

  try {
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    // Build WHERE conditions for history batches
    let whereConditions = ['ehc.seller_id = ?'];
    let values = [seller_id];

    // Search filter
    if (search) {
      whereConditions.push(`ehc.product_name LIKE ?`);
      values.push(`%${search}%`);
    }

    // Product filter
    if (product) {
      whereConditions.push(`ehc.product_name = ?`);
      values.push(product);
    }

    const whereClause = whereConditions.join(' AND ');

    // Get total count of unique batches
    const [countResult] = await pool.query(`
      SELECT COUNT(DISTINCT ehc.batch_id) as total
      FROM email_history_companies ehc
      WHERE ${whereClause}
    `, values);
    const totalBatches = countResult[0]?.total || 0;

    // Get paginated batches
    const [batches] = await pool.query(`
      SELECT 
        ehc.batch_id,
        MAX(ehc.product_name) as product_name,
        MAX(ehc.sent_at) as sent_at,
        MAX(ehc.multiple_products) as multiple_products,
        MAX(ehc.template_used) as template_used,
        COUNT(*) as total_companies,
        SUM(CASE WHEN ehc.message IS NOT NULL AND ehc.message <> '' THEN 1 ELSE 0 END) as replied_count,
        SUM(CASE WHEN ehc.response = 'interested' THEN 1 ELSE 0 END) as interested_count,
        SUM(CASE WHEN ehc.response = 'not_interested' THEN 1 ELSE 0 END) as not_interested_count
      FROM email_history_companies ehc
      WHERE ${whereClause}
      GROUP BY ehc.batch_id
      ORDER BY MAX(ehc.sent_at) DESC
      LIMIT ? OFFSET ?
    `, [...values, limitNum, offset]);

    const historyData = [];

    for (const batch of batches) {
      const [companies] = await pool.query(`
        SELECT
          company_name,
          contact_name,
          email,
          sent_at,
          response,
          template_used,
          message,
          reply_date,
          subject,
          product_name
        FROM email_history_companies
        WHERE batch_id = ? AND seller_id = ?
        ORDER BY sent_at DESC
      `, [batch.batch_id, seller_id]);

      const companiesList = companies.map(row => {
        const hasMessage = row.message && row.message.trim() !== '';
        const isInterested = row.response === 'interested';
        const isNotInterested = row.response === 'not_interested';

        let status = 'Email Sent';
        if (hasMessage && isInterested) status = 'Replied, Interested';
        else if (hasMessage && isNotInterested) status = 'Replied, Not Interested';
        else if (hasMessage) status = 'Replied';
        else if (isInterested) status = 'Interested';
        else if (isNotInterested) status = 'Not Interested';

        return {
          companyName: row.company_name,
          contactName: row.contact_name,
          email: row.email,
          sentAt: row.sent_at,
          response: row.response,
          respondedAt: row.reply_date,
          status,
          templateUsed: row.template_used,
          subject: row.subject,
          message: hasMessage ? row.message.split('\n')[0].trim() : null,
          product: row.product_name,
          hasReply: hasMessage,
          isInterested,
          isNotInterested
        };
      });

      const mainProduct = batch.multiple_products === 1 ? "General Products" : batch.product_name;

      historyData.push({
        id: batch.batch_id,
        product: mainProduct,
        multiple_products: batch.multiple_products,
        date: batch.sent_at,
        companies: companiesList,
        counts: {
          total: batch.total_companies,
          replied: batch.replied_count,
          interested: batch.interested_count,
          notInterested: batch.not_interested_count,
          emailSent: batch.total_companies - batch.replied_count
        }
      });
    }

    res.json({
      success: true,
      total: totalBatches,
      data: historyData,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(totalBatches / limitNum),
        totalItems: totalBatches,
        itemsPerPage: limitNum
      }
    });

  } catch (err) {
    console.error('GET /history error:', err);
    res.status(500).json({ error: err.message });
  }
});
app.get('/history/stats', async (req, res) => {
  const { seller_id } = req.query;

  if (!seller_id) {
    return res.status(400).json({ error: 'seller_id is required' });
  }

  try {
    // Get total entries (batches)
    const [batchResult] = await pool.query(`
      SELECT COUNT(DISTINCT batch_id) as total_entries
      FROM email_history_companies
      WHERE seller_id = ?
    `, [seller_id]);

    // Get total companies contacted
    const [companyResult] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as total_companies
      FROM email_history_companies
      WHERE seller_id = ?
    `, [seller_id]);

    // Get total replied
    const [repliedResult] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as total_replied
      FROM email_history_companies
      WHERE seller_id = ? 
      AND (message IS NOT NULL AND message <> '')
    `, [seller_id]);

    // Get total interested
    const [interestedResult] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as total_interested
      FROM email_history_companies
      WHERE seller_id = ? AND response = 'interested'
    `, [seller_id]);

    // Get total not interested
    const [notInterestedResult] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as total_not_interested
      FROM email_history_companies
      WHERE seller_id = ? AND response = 'not_interested'
    `, [seller_id]);

    const totalEntries = batchResult[0]?.total_entries || 0;
    const totalCompanies = companyResult[0]?.total_companies || 0;
    const totalReplied = repliedResult[0]?.total_replied || 0;
    const totalInterested = interestedResult[0]?.total_interested || 0;
    const totalNotInterested = notInterestedResult[0]?.total_not_interested || 0;

    res.json({
      success: true,
      data: {
        totalEntries,
        totalCompanies,
        totalReplied,
        totalInterested,
        totalNotInterested,
        responseRate: totalCompanies > 0 ? Math.round((totalReplied / totalCompanies) * 100) : 0,
        interestedRate: totalCompanies > 0 ? Math.round((totalInterested / totalCompanies) * 100) : 0
      }
    });

  } catch (err) {
    console.error('GET /history/stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/history/products', async (req, res) => {
  const { seller_id } = req.query;

  if (!seller_id) {
    return res.status(400).json({ error: 'seller_id is required' });
  }

  try {
    const [products] = await pool.query(`
      SELECT DISTINCT product_name as product
      FROM email_history_companies
      WHERE seller_id = ? 
      AND product_name IS NOT NULL 
      AND product_name <> ''
      ORDER BY product_name
    `, [seller_id]);

    res.json(products);
  } catch (err) {
    console.error('GET /history/products error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add this helper function at the top of your server.js
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

app.post('/api/store-response', async (req, res) => {
  const { 
    email, 
    response, 
    companyName, 
    country, 
    contactName, 
    productName,
    templateUsed,
    buyer_id,
    seller_id  // Add this to the destructuring
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
    
    // Get seller_id from request or fallback to null
    const sellerId = seller_id || null;
    
    const [result] = await pool.query(
      `INSERT INTO email_history_companies 
        (batch_id, buyer_id, seller_id, company_name, country, contact_name, email, 
         response, responded_at, product_name, template_used, status,
         from_email, to_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, 'responded', ?, ?)`,
      [
        batchId,
        buyer_id || null,
        sellerId,  // Add seller_id here
        companyName || null,
        country || null,
        contactName || null,
        email,
        response,
        productName || null,
        templateUsed || 'Manual Response',
        email,        
        yourEmail     
      ]
    );

    console.log('✅ New response stored:', {
      id: result.insertId,
      batchId,
      seller_id: sellerId,
      buyer_id: buyer_id,
      email,
      response,
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


app.get('/history/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { seller_id, page = 1, limit = 10 } = req.query;

    if (!seller_id) {
      return res.status(400).json({
        success: false,
        message: "seller_id is required"
      });
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    // Get total count of companies in this batch
    const [countResult] = await pool.query(`
      SELECT COUNT(*) as total
      FROM email_history_companies
      WHERE batch_id = ? AND seller_id = ?
    `, [id, seller_id]);

    const totalCompanies = countResult[0]?.total || 0;

    // Get batch info (first row to get product and metadata)
    const [batchInfo] = await pool.query(`
      SELECT
        batch_id AS id,
        product_name AS product,
        multiple_products,
        MAX(sent_at) AS sent_at
      FROM email_history_companies
      WHERE batch_id = ? AND seller_id = ?
      GROUP BY batch_id, product_name, multiple_products
    `, [id, seller_id]);

    if (!batchInfo.length) {
      return res.status(404).json({
        success: false,
        message: 'History not found'
      });
    }

    // Get paginated companies
    const [results] = await pool.query(`
      SELECT
        company_name,
        contact_name,
        email,
        sent_at,
        response,
        template_used,
        message,
        reply_date,
        subject,
        product_name AS product,
        status
      FROM email_history_companies
      WHERE batch_id = ? AND seller_id = ?
      ORDER BY sent_at DESC
      LIMIT ? OFFSET ?
    `, [id, seller_id, limitNum, offset]);

    // Get counts (total across all pages)
    const [countsResult] = await pool.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN message IS NOT NULL AND message <> '' THEN 1 ELSE 0 END) as replied,
        SUM(CASE WHEN response = 'interested' THEN 1 ELSE 0 END) as interested,
        SUM(CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END) as not_interested,
        SUM(CASE WHEN status = 'sent' OR response IS NULL THEN 1 ELSE 0 END) as emailSent
      FROM email_history_companies
      WHERE batch_id = ? AND seller_id = ?
    `, [id, seller_id]);

    const counts = countsResult[0] || {
      total: 0,
      replied: 0,
      interested: 0,
      not_interested: 0,
      emailSent: 0
    };

    const companies = results.map(row => {
      const hasMessage = row.message && row.message.trim() !== '';
      const isInterested = row.response === 'interested';
      const isNotInterested = row.response === 'not_interested';

      let status = 'Email Sent';
      if (hasMessage && isInterested) status = 'Replied, Interested';
      else if (hasMessage && isNotInterested) status = 'Replied, Not Interested';
      else if (hasMessage) status = 'Replied';
      else if (isInterested) status = 'Interested';
      else if (isNotInterested) status = 'Not Interested';

      return {
        companyName: row.company_name,
        contactName: row.contact_name,
        email: row.email,
        sentAt: row.sent_at,
        response: row.response,
        respondedAt: row.reply_date,
        status,
        templateUsed: row.template_used,
        subject: row.subject,
        message: hasMessage ? row.message.split('\n')[0].trim() : null,
        product: row.product,
        hasReply: hasMessage,
        isInterested,
        isNotInterested
      };
    });

    const multipleProducts = batchInfo[0].multiple_products;
    const mainProduct = multipleProducts === 1 ? "General Products" : batchInfo[0].product;

    res.json({
      success: true,
      data: {
        id: batchInfo[0].id,
        product: mainProduct,
        multiple_products: multipleProducts,
        date: batchInfo[0].sent_at,
        companies: companies,
        counts: {
          total: counts.total || 0,
          replied: counts.replied || 0,
          interested: counts.interested || 0,
          notInterested: counts.not_interested || 0,
          emailSent: counts.emailSent || 0
        }
      },
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(totalCompanies / limitNum),
        totalItems: totalCompanies,
        itemsPerPage: limitNum
      }
    });

  } catch (err) {
    console.error('GET /history/:id error:', err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

app.get('/api/admin/history', async (req, res) => {
  console.log('GET /api/admin/history called');
  
  try {
    // Get all records - NO seller_id filter
    const [results] = await pool.query(`
      SELECT 
        id,
        seller_id,
        company_name,
        country,
        contact_name,
        email,
        from_email,
        to_email,
        subject,
        message,
        product_name,
        reply_date,
        sent_at,
        status,
        template_used,
        response,
        responded_at,
        batch_id,
        buyer_id,
        multiple_products,
        template_id,
        DATE_FORMAT(sent_at, '%Y-%m-%d %H:%i:%s') as sent_at_formatted,
        DATE_FORMAT(reply_date, '%Y-%m-%d %H:%i:%s') as reply_date_formatted,
        DATE_FORMAT(responded_at, '%Y-%m-%d %H:%i:%s') as responded_at_formatted,
        CASE 
          WHEN message IS NOT NULL AND message != '' AND response = 'interested' THEN 'Replied, Interested'
          WHEN message IS NOT NULL AND message != '' AND response = 'not_interested' THEN 'Replied, Not Interested'
          WHEN message IS NOT NULL AND message != '' THEN 'Replied'
          WHEN response = 'interested' THEN 'Interested'
          WHEN response = 'not_interested' THEN 'Not Interested'
          WHEN status = 'sent' THEN 'Sent'
          ELSE 'Unknown'
        END as display_status,
        CASE 
          WHEN message IS NOT NULL AND message != '' THEN 1 
          ELSE 0 
        END as has_reply,
        CASE 
          WHEN response = 'interested' THEN 1 
          ELSE 0 
        END as is_interested,
        CASE 
          WHEN response = 'not_interested' THEN 1 
          ELSE 0 
        END as is_not_interested
      FROM email_history_companies
      ORDER BY sent_at DESC, id DESC
    `);
    
    console.log(`Found ${results.length} total records for admin`);
    
    if (results.length === 0) {
      return res.json({
        success: true,
        message: 'No history records found',
        data: [],
        total: 0,
        summary: {
          total_records: 0,
          total_sellers: 0,
          total_batches: 0,
          total_buyers: 0,
          total_sent: 0,
          total_replied: 0,
          total_interested: 0,
          total_not_interested: 0
        }
      });
    }

    // Get summary statistics
    const [stats] = await pool.query(`
      SELECT 
        COUNT(*) as total_records,
        COUNT(DISTINCT seller_id) as total_sellers,
        COUNT(DISTINCT batch_id) as total_batches,
        COUNT(DISTINCT buyer_id) as total_buyers,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as total_sent,
        SUM(CASE WHEN message IS NOT NULL AND message != '' THEN 1 ELSE 0 END) as total_replied,
        SUM(CASE WHEN response = 'interested' THEN 1 ELSE 0 END) as total_interested,
        SUM(CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END) as total_not_interested
      FROM email_history_companies
    `);

    // Get seller breakdown
    const [sellerBreakdown] = await pool.query(`
      SELECT 
        seller_id,
        COUNT(*) as total_records,
        COUNT(DISTINCT batch_id) as total_batches,
        COUNT(DISTINCT buyer_id) as total_buyers,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent_count,
        SUM(CASE WHEN message IS NOT NULL AND message != '' THEN 1 ELSE 0 END) as replied_count,
        SUM(CASE WHEN response = 'interested' THEN 1 ELSE 0 END) as interested_count,
        SUM(CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END) as not_interested_count
      FROM email_history_companies
      GROUP BY seller_id
      ORDER BY total_records DESC
    `);

    // Get batch breakdown
    const [batchBreakdown] = await pool.query(`
      SELECT 
        batch_id,
        seller_id,
        COUNT(*) as total_records,
        MAX(product_name) as product_name,
        MIN(sent_at) as first_sent,
        MAX(sent_at) as last_sent,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent_count,
        SUM(CASE WHEN message IS NOT NULL AND message != '' THEN 1 ELSE 0 END) as replied_count,
        SUM(CASE WHEN response = 'interested' THEN 1 ELSE 0 END) as interested_count,
        SUM(CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END) as not_interested_count
      FROM email_history_companies
      GROUP BY batch_id, seller_id
      ORDER BY last_sent DESC
    `);

    res.json({
      success: true,
      total: results.length,
      data: results,
      summary: {
        total_records: stats[0]?.total_records || 0,
        total_sellers: stats[0]?.total_sellers || 0,
        total_batches: stats[0]?.total_batches || 0,
        total_buyers: stats[0]?.total_buyers || 0,
        total_sent: stats[0]?.total_sent || 0,
        total_replied: stats[0]?.total_replied || 0,
        total_interested: stats[0]?.total_interested || 0,
        total_not_interested: stats[0]?.total_not_interested || 0
      },
      seller_breakdown: sellerBreakdown,
      batch_breakdown: batchBreakdown
    });

  } catch (err) {
    console.error('GET /api/admin/history error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get('/api/admin/history/:id', async (req, res) => {
  const { id } = req.params;
  
  console.log('GET /api/admin/history/:id called with id:', id);
  
  try {
    // First try to find records with this buyer_id
    let [results] = await pool.query(`
      SELECT 
        id,
        buyer_id,
        batch_id,
        seller_id,
        company_name,
        country,
        contact_name,
        from_email,
        to_email,
        subject,
        message,
        product_name,
        sent_at,
        reply_date,
        responded_at,
        status,
        template_used,
        response,
        DATE_FORMAT(sent_at, '%Y-%m-%d %H:%i:%s') as sent_at_formatted,
        DATE_FORMAT(reply_date, '%Y-%m-%d %H:%i:%s') as reply_date_formatted,
        DATE_FORMAT(responded_at, '%Y-%m-%d %H:%i:%s') as responded_at_formatted,
        CASE 
          WHEN message IS NOT NULL AND message != '' AND response = 'interested' THEN 'Replied, Interested'
          WHEN message IS NOT NULL AND message != '' AND response = 'not_interested' THEN 'Replied, Not Interested'
          WHEN message IS NOT NULL AND message != '' THEN 'Replied'
          WHEN response = 'interested' THEN 'Interested'
          WHEN response = 'not_interested' THEN 'Not Interested'
          WHEN status = 'sent' THEN 'Sent'
          ELSE 'Unknown'
        END as display_status
      FROM email_history_companies
      WHERE buyer_id = ?
      ORDER BY sent_at DESC, id DESC
    `, [id]);
    
    if (results.length === 0) {
      [results] = await pool.query(`
        SELECT 
          id,
          buyer_id,
          batch_id,
          seller_id,
          company_name,
          country,
          contact_name,
          from_email,
          to_email,
          subject,
          message,
          product_name,
          sent_at,
          reply_date,
          responded_at,
          status,
          template_used,
          response,
          DATE_FORMAT(sent_at, '%Y-%m-%d %H:%i:%s') as sent_at_formatted,
          DATE_FORMAT(reply_date, '%Y-%m-%d %H:%i:%s') as reply_date_formatted,
          DATE_FORMAT(responded_at, '%Y-%m-%d %H:%i:%s') as responded_at_formatted,
          CASE 
            WHEN message IS NOT NULL AND message != '' AND response = 'interested' THEN 'Replied, Interested'
            WHEN message IS NOT NULL AND message != '' AND response = 'not_interested' THEN 'Replied, Not Interested'
            WHEN message IS NOT NULL AND message != '' THEN 'Replied'
            WHEN response = 'interested' THEN 'Interested'
            WHEN response = 'not_interested' THEN 'Not Interested'
            WHEN status = 'sent' THEN 'Sent'
            ELSE 'Unknown'
          END as display_status
        FROM email_history_companies
        WHERE id = ?
        ORDER BY sent_at DESC, id DESC
      `, [id]);
    }
    
    if (results.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No records found for this buyer'
      });
    }

    // Clean the message for each result
    const cleanedResults = results.map(row => {
      let cleanedMessage = row.message;
      
      if (cleanedMessage) {
        // Remove quoted/replied content (everything after "wrote:" or "On ... wrote:")
        const patterns = [
          /\nOn\s+.+\s+wrote:\s*\n/i,
          /\n-----Original Message-----\s*\n/i,
          /\n>+\s*.+\n/i,
          /\n\n\n.*\nOn\s+/s,
          /\n\n.*wrote:\s*\n/s
        ];
        
        let replyEndIndex = -1;
        for (const pattern of patterns) {
          const match = cleanedMessage.match(pattern);
          if (match) {
            replyEndIndex = match.index;
            break;
          }
        }
        
        if (replyEndIndex !== -1) {
          cleanedMessage = cleanedMessage.substring(0, replyEndIndex).trim();
        } else {
          // If no pattern found, take only the first paragraph
          const parts = cleanedMessage.split(/\n\s*\n\s*\n/);
          if (parts.length > 0) {
            cleanedMessage = parts[0].trim();
          }
        }
        
        // Remove any remaining quoted lines (starting with >)
        cleanedMessage = cleanedMessage.split('\n')
          .filter(line => !line.trim().startsWith('>'))
          .join('\n')
          .trim();
        
        // Remove special characters and URLs
        cleanedMessage = cleanedMessage
          .replace(/\\u003C/g, '<')
          .replace(/\\u003E/g, '>')
          .replace(/\[[^\]]*\]/g, '')
          .replace(/https?:\/\/[^\s]+/g, '')
          .trim();
      }
      
      // Clean subject as well
      let cleanedSubject = row.subject;
      if (cleanedSubject) {
        cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
        cleanedSubject = cleanedSubject.replace(/^Re:\s*/i, '');
        cleanedSubject = cleanedSubject.trim();
      }
      
      return {
        ...row,
        message: cleanedMessage,
        subject: cleanedSubject
      };
    });

    // Get buyer info from first record
    const firstRecord = results[0];
    const buyerInfo = {
      buyer_id: firstRecord.buyer_id,
      company_name: firstRecord.company_name,
      country: firstRecord.country,
      product_name: firstRecord.product_name,
      contact_name: firstRecord.contact_name,
      email: firstRecord.from_email || firstRecord.email,
      all_emails: firstRecord.from_email || '',
      all_contacts: firstRecord.contact_name || '',
      seller_id: firstRecord.seller_id
    };

    // Calculate summary
    const summary = {
      total: results.length,
      sent: results.filter(r => r.status === 'sent' || r.display_status === 'Sent').length,
      replied: results.filter(r => r.message && r.message.trim() !== '').length,
      interested: results.filter(r => r.response === 'interested').length,
      not_interested: results.filter(r => r.response === 'not_interested').length,
      last_activity: results[0]?.sent_at || null
    };

    res.json({
      success: true,
      data: cleanedResults,
      buyer_info: buyerInfo,
      summary: summary
    });

  } catch (err) {
    console.error('GET /api/admin/history/:id error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});


app.get('/api/contacts/stats', async (req, res) => {
  const { seller_id } = req.query;

  if (!seller_id) {
    return res.status(400).json({ success: false, message: "seller_id is required" });
  }

  try {
    // Get total distinct buyers
    const [totalResult] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as total
      FROM email_history_companies
      WHERE seller_id = ?
    `, [seller_id]);

    // Get interested count
    const [interestedResult] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as interested
      FROM email_history_companies
      WHERE seller_id = ? AND response = 'interested'
    `, [seller_id]);

    // Get not_interested count
    const [notInterestedResult] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as not_interested
      FROM email_history_companies
      WHERE seller_id = ? AND response = 'not_interested'
    `, [seller_id]);

    // Get pending count (no response yet)
    const [pendingResult] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as pending
      FROM email_history_companies
      WHERE seller_id = ? AND (response IS NULL OR response = '')
    `, [seller_id]);

    const total = totalResult[0]?.total || 0;
    const interested = interestedResult[0]?.interested || 0;
    const not_interested = notInterestedResult[0]?.not_interested || 0;
    const pending = pendingResult[0]?.pending || 0;

    console.log('Stats for seller:', seller_id, { total, interested, not_interested, pending });

    res.json({
      success: true,
      data: {
        total: total,
        interested: interested,
        not_interested: not_interested,
        pending: pending
      }
    });

  } catch (error) {
    console.error("Error fetching contacts stats:", error);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching contacts stats", 
      error: error.message 
    });
  }
});
app.get('/api/contacts/templates', async (req, res) => {
  const { seller_id } = req.query;

  if (!seller_id) {
    return res.status(400).json({ success: false, message: "seller_id is required" });
  }

  try {
    const [templates] = await pool.query(`
      SELECT DISTINCT template_used as template
      FROM email_history_companies 
      WHERE seller_id = ? 
      AND template_used IS NOT NULL 
      AND template_used != ''
      ORDER BY template_used
      LIMIT 100
    `, [seller_id]);

    res.json(templates);
  } catch (error) {
    console.error("Error fetching contacts templates:", error);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching templates", 
      error: error.message 
    });
  }
});
app.get('/api/contacts/search', async (req, res) => {
  const { seller_id, q = '', page = 1, limit = 10 } = req.query;

  if (!seller_id) {
    return res.status(400).json({ success: false, message: "seller_id is required" });
  }

  try {
    const offset = (Number(page) - 1) * Number(limit);
    const limitNum = Number(limit);

    const searchPattern = `%${q}%`;

    const [results] = await pool.query(`
      SELECT 
        buyer_id,
        MAX(contact_name) as contact_name,
        MAX(from_email) as from_email,
        MAX(to_email) as to_email,
        MAX(company_name) as company_name,
        MAX(country) as country,
        MAX(product_name) as product_name,
        MAX(template_used) as template_used,
        COUNT(*) as interaction_count,
        MAX(CASE WHEN LOWER(status) = 'sent' THEN 1 ELSE 0 END) as has_sent,
        MAX(CASE WHEN LOWER(response) = 'interested' THEN 1 ELSE 0 END) as has_interested,
        MAX(CASE WHEN LOWER(response) = 'not_interested' THEN 1 ELSE 0 END) as has_not_interested,
        MAX(CASE WHEN reply_date IS NOT NULL OR responded_at IS NOT NULL THEN 1 ELSE 0 END) as has_replied,
        MAX(COALESCE(reply_date, responded_at, sent_at)) as last_interaction,
        MAX(email) as email
      FROM email_history_companies
      WHERE seller_id = ?
        AND (
          company_name LIKE ? OR 
          country LIKE ? OR 
          product_name LIKE ? OR 
          contact_name LIKE ? OR 
          to_email LIKE ? OR
          from_email LIKE ? OR
          email LIKE ?
        )
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
      LIMIT ? OFFSET ?
    `, [seller_id, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, limitNum, offset]);

    const [countResult] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as total
      FROM email_history_companies
      WHERE seller_id = ?
        AND (
          company_name LIKE ? OR 
          country LIKE ? OR 
          product_name LIKE ? OR 
          contact_name LIKE ? OR 
          to_email LIKE ? OR
          from_email LIKE ? OR
          email LIKE ?
        )
    `, [seller_id, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern]);

    const cleanedResults = results.map(contact => ({
      buyer_id: contact.buyer_id,
      contact_name: contact.contact_name || 'Unknown',
      from_email: contact.from_email || '',
      to_email: contact.to_email || '',
      company_name: contact.company_name || '',
      country: contact.country || '',
      product_name: contact.product_name || '',
      template_used: contact.template_used || '',
      phone: contact.contact_name && contact.contact_name.match(/^\+?\d+$/) ? contact.contact_name : '',
      interaction_count: contact.interaction_count,
      status: contact.has_sent ? 'sent' : 'pending',
      response: contact.has_interested ? 'interested' : contact.has_not_interested ? 'not_interested' : contact.has_replied ? 'replied' : null,
      email: contact.email || contact.from_email || '',
      last_interaction: contact.last_interaction
    }));

    res.json({
      success: true,
      data: cleanedResults,
      total: countResult[0]?.total || 0,
      pagination: {
        total: countResult[0]?.total || 0,
        page: Number(page),
        limit: limitNum,
        totalPages: Math.ceil((countResult[0]?.total || 0) / limitNum)
      }
    });

  } catch (error) {
    console.error("Error searching contacts:", error);
    res.status(500).json({ 
      success: false, 
      message: "Error searching contacts", 
      error: error.message 
    });
  }
});
app.get('/history/:id/replies', async (req, res) => {
  try {
    const { id } = req.params;

    const [replies] = await pool.query(`
      SELECT
        r.id,
        r.from_email,
        r.subject,
        r.message,
        r.reply_date,
        c.company_name,
        c.contact_name
      FROM email_replies r
      LEFT JOIN email_history_companies c
        ON c.history_id = r.batch_id AND c.email = r.from_email
      WHERE r.batch_id = ?
      ORDER BY r.reply_date DESC
    `, [id]);

    res.json({ batchId: id, total: replies.length, replies });

  } catch (err) {
    console.error('GET /history/:id/replies error:', err);
    res.status(500).json({ error: err.message });
  }
});


app.post("/email-templates", async (req, res) => {
  try {
    const { name, subject, body } = req.body;

    if (!name || !subject || !body) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    const [result] = await pool.query(
      `INSERT INTO email_templates (name, subject, body) VALUES (?, ?, ?)`,
      [name, subject, body]
    );

    res.json({ success: true, message: "Template created successfully", insertId: result.insertId });

  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/email-templates", async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM email_templates ORDER BY id DESC`);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.delete("/email-templates/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM email_templates WHERE id = ?`, [id]);
    res.json({ success: true, message: "Template deleted successfully" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get('/api/contacts', async (req, res) => {
  const { 
    seller_id, 
    search = '', 
    template = '',
    response_type = '',
    page = 1, 
    limit = 10 
  } = req.query;

  if (!seller_id) {
    return res.status(400).json({ success: false, message: "seller_id is required" });
  }

  try {
    const offset = (Number(page) - 1) * Number(limit);
    const limitNum = Number(limit);

    // Build WHERE conditions - SIMPLE like Search page
    let whereConditions = ['e.seller_id = ?'];
    let values = [seller_id];

    // Search filter - SIMPLE LIKE (same as Search page)
    if (search) {
      const searchPattern = `%${search}%`;
      whereConditions.push(`(
        e.company_name LIKE ? OR 
        e.product_name LIKE ? OR 
        e.contact_name LIKE ? OR 
        e.email LIKE ?
      )`);
      values.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    // Template filter
    if (template && template !== 'all') {
      whereConditions.push(`e.template_used = ?`);
      values.push(template);
    }

    // Response type filter
    if (response_type && response_type !== 'all') {
      if (response_type === 'interested') {
        whereConditions.push(`e.response = 'interested'`);
      } else if (response_type === 'not_interested') {
        whereConditions.push(`e.response = 'not_interested'`);
      } else if (response_type === 'replied') {
        whereConditions.push(`(e.reply_date IS NOT NULL OR e.responded_at IS NOT NULL)`);
      } else if (response_type === 'sent') {
        whereConditions.push(`e.status = 'sent'`);
      }
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Get total count - SIMPLE COUNT
    const countQuery = `
      SELECT COUNT(DISTINCT e.buyer_id) as total
      FROM email_history_companies e
      ${whereClause}
    `;

    const [countResult] = await pool.query(countQuery, values);
    const total = countResult[0]?.total || 0;

    // Get paginated contacts - SIMPLE QUERY (like Search page)
    const query = `
      SELECT 
        e.buyer_id,
        e.contact_name,
        e.from_email,
        e.company_name,
        e.product_name,
        e.template_used,
        e.email,
        e.reply_date,
        e.responded_at,
        e.sent_at,
        e.response,
        e.status
      FROM email_history_companies e
      ${whereClause}
      ORDER BY COALESCE(e.reply_date, e.responded_at, e.sent_at) DESC
      LIMIT ? OFFSET ?
    `;

    const [results] = await pool.query(query, [...values, limitNum, offset]);

    // If no results, return early
    if (results.length === 0) {
      return res.json({ 
        success: true, 
        data: [],
        total: 0,
        pagination: {
          total: 0,
          page: Number(page),
          limit: limitNum,
          totalPages: 0
        }
      });
    }

    // Process results - GROUP BY in JavaScript (not in SQL)
    const contactMap = new Map();

    results.forEach(row => {
      if (!contactMap.has(row.buyer_id)) {
        contactMap.set(row.buyer_id, {
          buyer_id: row.buyer_id,
          contact_name: row.contact_name || 'Unknown',
          from_email: row.from_email || '',
          company_name: row.company_name || '',
          product_name: row.product_name || '',
          template_used: row.template_used || '',
          phone: row.contact_name && row.contact_name.match(/^\+?\d+$/) ? row.contact_name : '',
          interaction_count: 0,
          response: null,
          email: row.email || row.from_email || '',
          last_interaction: row.sent_at || row.reply_date || row.responded_at,
          has_interested: false,
          has_not_interested: false,
          has_replied: false
        });
      }

      const contact = contactMap.get(row.buyer_id);
      contact.interaction_count++;

      if (row.response === 'interested') {
        contact.has_interested = true;
        contact.response = 'interested';
      } else if (row.response === 'not_interested') {
        contact.has_not_interested = true;
        contact.response = 'not_interested';
      } else if (row.reply_date || row.responded_at) {
        contact.has_replied = true;
        contact.response = 'replied';
      }

      // Update last_interaction if this record is newer
      const recordDate = row.reply_date || row.responded_at || row.sent_at;
      if (recordDate && (!contact.last_interaction || new Date(recordDate) > new Date(contact.last_interaction))) {
        contact.last_interaction = recordDate;
      }
    });

    // Convert map to array and set final response
    const cleanedResults = Array.from(contactMap.values()).map(contact => ({
      ...contact,
      response: contact.has_interested ? 'interested' : 
                contact.has_not_interested ? 'not_interested' : 
                contact.has_replied ? 'replied' : null
    }));

    // Sort by last_interaction (newest first)
    cleanedResults.sort((a, b) => {
      return new Date(b.last_interaction) - new Date(a.last_interaction);
    });

    res.json({ 
      success: true, 
      data: cleanedResults,
      total: total,
      pagination: {
        total: total,
        page: Number(page),
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
      }
    });

  } catch (error) {
    console.error("Error fetching contacts:", error);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching contacts", 
      error: error.message 
    });
  }
});
// Get stats for a specific buyer
app.get('/api/replyhistory/:buyerId/stats', async (req, res) => {
  try {
    const buyerId = req.params.buyerId;
    const sellerId = req.query.sellerId;

    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: "sellerId is required"
      });
    }

    const query = `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN response = 'interested' THEN 1 ELSE 0 END) as interested,
        SUM(CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END) as not_interested,
        SUM(CASE WHEN response IS NULL OR response = '' THEN 1 ELSE 0 END) as pending
      FROM email_history_companies
      WHERE buyer_id = ? AND seller_id = ?
    `;

    const [results] = await pool.query(query, [buyerId, sellerId]);

    res.json({
      success: true,
      data: {
        total: results[0]?.total || 0,
        sent: results[0]?.sent || 0,
        interested: results[0]?.interested || 0,
        not_interested: results[0]?.not_interested || 0,
        pending: results[0]?.pending || 0
      }
    });

  } catch (error) {
    console.error("Error fetching contact stats:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching contact stats",
      error: error.message
    });
  }
});

app.get('/api/replyhistory/:buyerId', async (req, res) => {
  try {
    const buyerId = req.params.buyerId;
    const sellerId = req.query.sellerId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: "sellerId is required"
      });
    }

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM email_history_companies
      WHERE buyer_id = ? AND seller_id = ?
    `;
    const [countResult] = await pool.query(countQuery, [buyerId, sellerId]);
    const total = countResult[0]?.total || 0;

    // Get paginated results with email column
    const query = `
      SELECT 
        id,
        batch_id,
        buyer_id,
        seller_id,
        from_email,
        to_email,
        email,
        subject,
        message,
        product_name,
        reply_date,
        company_name,
        contact_name,
        country,
        status,
        template_used,
        response,
        responded_at,
        sent_at
      FROM email_history_companies
      WHERE buyer_id = ? AND seller_id = ?
      ORDER BY COALESCE(reply_date, responded_at, sent_at) DESC
      LIMIT ? OFFSET ?
    `;

    const [results] = await pool.query(query, [buyerId, sellerId, limit, offset]);

    // Clean the message and subject for each record
    const cleanedResults = results.map(reply => {
      let cleanedSubject = reply.subject || '';
      cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
      cleanedSubject = cleanedSubject.replace(/^Re:\s*/, '');

      let cleanedMessage = reply.message || '';

      if (reply.response !== 'interested') {
        const quotePatterns = [
          /\nOn\s+.+\s+wrote:\s*\n/i,
          /\n-----Original Message-----\s*\n/i,
          /\n>+\s*.+\n/i,
          /\n\n\n.*\nOn\s+/s
        ];

        let replyEndIndex = -1;
        for (const pattern of quotePatterns) {
          const match = cleanedMessage.match(pattern);
          if (match) {
            replyEndIndex = match.index;
            break;
          }
        }

        if (replyEndIndex !== -1) {
          cleanedMessage = cleanedMessage.substring(0, replyEndIndex).trim();
        } else {
          const parts = cleanedMessage.split(/\n\s*\n\s*\n/);
          if (parts.length > 0) {
            cleanedMessage = parts[0].trim();
          }
        }

        cleanedMessage = cleanedMessage
          .replace(/\\u003C/g, '<')
          .replace(/\\u003E/g, '>')
          .replace(/\[[^\]]*\]/g, '')
          .trim();
      }

      return {
        id: reply.id,
        batch_id: reply.batch_id,
        seller_id: reply.seller_id,
        buyer_id: reply.buyer_id,
        from_email: reply.from_email,
        to_email: reply.to_email,
        email: reply.email ,
        subject: cleanedSubject,
        message: cleanedMessage,
        product_name: reply.product_name,
        reply_date: reply.reply_date || reply.responded_at,
        company_name: reply.company_name,
        contact_name: reply.contact_name,
        country: reply.country,
        status: reply.status,
        template_used: reply.template_used,
        response: reply.response,
        responded_at: reply.responded_at,
        sent_at: reply.sent_at
      };
    });

    res.json({
      success: true,
      count: cleanedResults.length,
      total: total,
      data: cleanedResults,
      pagination: {
        total: total,
        page: page,
        limit: limit,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error("Error fetching buyer details:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching buyer details",
      error: error.message
    });
  }
});

app.get('/api/tracking/counts', async (req, res) => {
  const { seller_id } = req.query;

  if (!seller_id) {
    return res.status(400).json({
      success: false,
      error: "seller_id is required"
    });
  }

  try {
    const [results] = await pool.query(`
      SELECT 
        (SELECT COUNT(DISTINCT buyer_id) FROM email_history_companies 
         WHERE seller_id = ? AND status = 'sent') AS sent,
        
        (SELECT COUNT(DISTINCT buyer_id) FROM email_history_companies 
         WHERE seller_id = ? AND message IS NOT NULL AND message <> '' AND reply_date IS NOT NULL) AS replied,
        
        (SELECT COUNT(DISTINCT buyer_id) FROM email_history_companies 
         WHERE seller_id = ? AND response = 'interested') AS interested,
        
        (SELECT COUNT(DISTINCT buyer_id) FROM email_history_companies 
         WHERE seller_id = ? AND response = 'not_interested') AS not_interested,
        
        (SELECT COUNT(DISTINCT buyer_id) FROM email_history_companies 
         WHERE seller_id = ?) AS total_contacted
    `, [seller_id, seller_id, seller_id, seller_id, seller_id]);

    const data = results[0] || {};

    res.json({
      success: true,
      data: {
        sent: data.sent || 0,
        replied: data.replied || 0,
        interested: data.interested || 0,
        not_interested: data.not_interested || 0
      },
      total: {
        all: data.total_contacted || 0
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ==================== TRACKING ALL API WITH PAGINATION ====================
app.get('/api/tracking/page', async (req, res) => {
  const { seller_id, page = 1, limit = 10 } = req.query;

  if (!seller_id) {
    return res.status(400).json({
      success: false,
      error: "seller_id is required"
    });
  }

  try {
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    // Get total count of ALL individual email records
    const [[totalResult]] = await pool.query(`
      SELECT COUNT(*) AS total
      FROM email_history_companies
      WHERE seller_id = ?
    `, [seller_id]);

    const totalContacted = totalResult.total || 0;

    // Get paginated data - EACH INDIVIDUAL EMAIL (NO GROUP BY)
    const [allData] = await pool.query(`
      SELECT
        id,
        buyer_id,
        company_name,
        country,
        contact_name,
        email,
        product_name,
        sent_at,
        reply_date,
        responded_at,
        response,
        status,
        template_used,
        subject,
        message,
        CASE
          WHEN response = 'interested' THEN 'interested'
          WHEN response = 'not_interested' THEN 'not_interested'
          WHEN reply_date IS NOT NULL AND response IS NULL THEN 'replied'
          WHEN status = 'sent' AND response IS NULL AND reply_date IS NULL THEN 'sent'
          ELSE 'sent'
        END AS current_status,
        COALESCE(responded_at, reply_date, sent_at) AS last_interaction
      FROM email_history_companies
      WHERE seller_id = ?
      ORDER BY sent_at DESC
      LIMIT ? OFFSET ?
    `, [seller_id, limitNum, offset]);

    // Categorize by individual email status
    const sent = allData.filter(item => item.current_status === 'sent');
    const replied = allData.filter(item => item.current_status === 'replied');
    const interested = allData.filter(item => item.current_status === 'interested');
    const not_interested = allData.filter(item => item.current_status === 'not_interested');

    // Get counts for each status (counting individual emails)
    const [[countsResult]] = await pool.query(`
      SELECT
        SUM(CASE 
          WHEN response = 'interested' THEN 1 
          WHEN response = 'not_interested' THEN 1 
          WHEN reply_date IS NOT NULL AND response IS NULL THEN 1 
          WHEN status = 'sent' AND response IS NULL AND reply_date IS NULL THEN 1 
          ELSE 0 
        END) AS total_emails,
        SUM(CASE WHEN response = 'interested' THEN 1 ELSE 0 END) AS interested_count,
        SUM(CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END) AS not_interested_count,
        SUM(CASE WHEN reply_date IS NOT NULL AND response IS NULL THEN 1 ELSE 0 END) AS replied_count,
        SUM(CASE WHEN status = 'sent' AND response IS NULL AND reply_date IS NULL THEN 1 ELSE 0 END) AS sent_count
      FROM email_history_companies
      WHERE seller_id = ?
    `, [seller_id]);

    res.json({
      success: true,
      data: {
        sent,
        replied,
        interested,
        not_interested
      },
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(totalContacted / limitNum),
        totalItems: totalContacted,
        itemsPerPage: limitNum
      },
      counts: {
        sent: countsResult.sent_count || 0,
        replied: countsResult.replied_count || 0,
        interested: countsResult.interested_count || 0,
        not_interested: countsResult.not_interested_count || 0
      }
    });

  } catch (err) {
    console.error("GET /api/tracking/all:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});



app.get('/api/tracking/buyer/:id', async (req, res) => {
  const buyerId = req.params.id;
  const sellerId = req.query.sellerId;
  
  try {
    // Validate sellerId
    if (!sellerId) {
      return res.status(400).json({ 
        success: false, 
        message: 'sellerId is required' 
      });
    }

    // 1. Get buyer basic information
    const [buyerInfoResult] = await pool.query(`
      SELECT 
        b.id as buyer_id,
        b.company_name,
        b.country,
        b.product,
        GROUP_CONCAT(DISTINCT be.email SEPARATOR ', ') as emails,
        GROUP_CONCAT(DISTINCT bc.contact_number SEPARATOR ', ') as contacts
      FROM buyers b
      LEFT JOIN buyer_emails be ON b.id = be.buyer_id
      LEFT JOIN buyer_contacts bc ON b.id = bc.buyer_id
      WHERE b.id = ?
      GROUP BY b.id
    `, [buyerId]);

    if (buyerInfoResult.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Buyer not found' 
      });
    }

    const buyerInfo = buyerInfoResult[0];

    // 2. Get ALL communications for this buyer filtered by seller_id
    const [communications] = await pool.query(`
      SELECT 
        id,
        buyer_id,
        batch_id,
        company_name,
        country,
        contact_name,
        email as from_email,
        to_email,
        subject,
        message,
        product_name,
        sent_at,
        reply_date,
        responded_at,
        status,
        template_used,
        response,
        seller_id,
        'email' as record_type
      FROM email_history_companies
      WHERE buyer_id = ? AND seller_id = ?
      ORDER BY COALESCE(sent_at, reply_date, responded_at) DESC
    `, [buyerId, sellerId]);

    // 3. Process and clean the communications
    const processedCommunications = communications.map(comm => {
      let cleanedSubject = comm.subject || '';
      let cleanedMessage = comm.message || '';
      
      // Clean subject
      cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
      cleanedSubject = cleanedSubject.replace(/^Re:\s*/i, '');
      
      // Clean message (remove email reply headers)
      if (cleanedMessage) {
        const onIndex = cleanedMessage.indexOf('\nOn ');
        if (onIndex !== -1) {
          cleanedMessage = cleanedMessage.substring(0, onIndex).trim();
        }
        
        const wroteIndex = cleanedMessage.indexOf('wrote:');
        if (wroteIndex !== -1) {
          cleanedMessage = cleanedMessage.substring(0, wroteIndex).trim();
        }
        
        cleanedMessage = cleanedMessage
          .replace(/\\u003C/g, '<')
          .replace(/\\u003E/g, '>')
          .replace(/\[[^\]]*\]/g, '')
          .replace(/https?:\/\/[^\s]+/g, '')
          .replace(/\n\s*\n\s*\n/g, '\n\n')
          .trim();
      }
      
      // Determine display status based on actual data
      let display_status = 'Unknown';
      if (comm.response === 'interested') {
        display_status = 'Interested';
      } else if (comm.response === 'not_interested') {
        display_status = 'Not Interested';
      } else if (comm.reply_date && comm.reply_date !== null) {
        display_status = 'Replied';
      } else if (comm.status === 'sent' || comm.status === 'Manual Entry') {
        display_status = 'Sent';
      }
      
      return {
        ...comm,
        subject: cleanedSubject || 'No Subject',
        message: cleanedMessage || 'No message content',
        display_status,
        date: comm.sent_at || comm.reply_date || comm.responded_at || comm.sent_at
      };
    });

    // 4. Calculate summary statistics
    const summary = {
      total: processedCommunications.length,
      sent: processedCommunications.filter(c => c.display_status === 'Sent').length,
      replied: processedCommunications.filter(c => c.display_status === 'Replied').length,
      interested: processedCommunications.filter(c => c.display_status === 'Interested').length,
      not_interested: processedCommunications.filter(c => c.display_status === 'Not Interested').length,
      last_activity: processedCommunications[0]?.date || null
    };

    res.json({
      success: true,
      data: processedCommunications,
      buyer_info: {
        buyer_id: buyerInfo.buyer_id,
        company_name: buyerInfo.company_name,
        country: buyerInfo.country,
        product_name: buyerInfo.product,
        contact_name: buyerInfo.contacts?.split(',')[0]?.trim() || 'N/A',
        email: buyerInfo.emails?.split(',')[0]?.trim() || 'N/A',
        all_emails: buyerInfo.emails,
        all_contacts: buyerInfo.contacts,
        seller_id: sellerId
      },
      summary: summary
    });

  } catch (err) {
    console.error('GET /api/tracking/buyer/:id error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});


// GET /api/tracking/buyer/:buyerId - Get buyer communications with pagination
app.get('/api/tracking/buyer/:buyerId', async (req, res) => {
  const { buyerId } = req.params;
  const { sellerId, page = 1, limit = 10 } = req.query;

  if (!buyerId) {
    return res.status(400).json({
      success: false,
      message: 'buyerId is required'
    });
  }

  if (!sellerId) {
    return res.status(400).json({
      success: false,
      message: 'sellerId is required'
    });
  }

  try {
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    // 1. Get buyer info
    const [buyerInfo] = await pool.query(`
      SELECT 
        b.id as buyer_id,
        b.company_name,
        b.country,
        b.product as product_name,
        GROUP_CONCAT(DISTINCT bc.contact_number SEPARATOR ', ') as contacts,
        GROUP_CONCAT(DISTINCT be.email SEPARATOR ', ') as emails,
        b.buyer_date
      FROM buyers b
      LEFT JOIN buyer_contacts bc ON b.id = bc.buyer_id
      LEFT JOIN buyer_emails be ON b.id = be.buyer_id
      WHERE b.id = ?
      GROUP BY b.id
    `, [buyerId]);

    if (buyerInfo.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Buyer not found'
      });
    }

    const buyer = buyerInfo[0];

    // 2. Get total count of communications for this buyer
    const [countResult] = await pool.query(`
      SELECT COUNT(*) as total
      FROM email_history_companies
      WHERE buyer_id = ? AND seller_id = ?
    `, [buyerId, sellerId]);

    const total = countResult[0]?.total || 0;

    // 3. Get paginated communications
    const [communications] = await pool.query(`
      SELECT 
        id,
        buyer_id,
        batch_id,
        company_name,
        country,
        contact_name,
        email as from_email,
        to_email,
        subject,
        message,
        product_name,
        sent_at,
        reply_date,
        responded_at,
        status,
        template_used,
        response,
        seller_id,
        'email' as record_type
      FROM email_history_companies
      WHERE buyer_id = ? AND seller_id = ?
      ORDER BY COALESCE(sent_at, reply_date, responded_at) DESC
      LIMIT ? OFFSET ?
    `, [buyerId, sellerId, limitNum, offset]);

    // 4. Process communications
    const processedCommunications = communications.map(comm => {
      let cleanedSubject = comm.subject || '';
      let cleanedMessage = comm.message || '';
      
      cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
      cleanedSubject = cleanedSubject.replace(/^Re:\s*/i, '');
      
      if (cleanedMessage) {
        const onIndex = cleanedMessage.indexOf('\nOn ');
        if (onIndex !== -1) {
          cleanedMessage = cleanedMessage.substring(0, onIndex).trim();
        }
        const wroteIndex = cleanedMessage.indexOf('wrote:');
        if (wroteIndex !== -1) {
          cleanedMessage = cleanedMessage.substring(0, wroteIndex).trim();
        }
        cleanedMessage = cleanedMessage
          .replace(/\\u003C/g, '<')
          .replace(/\\u003E/g, '>')
          .replace(/\[[^\]]*\]/g, '')
          .replace(/https?:\/\/[^\s]+/g, '')
          .replace(/\n\s*\n\s*\n/g, '\n\n')
          .trim();
      }
      
      let display_status = 'Unknown';
      if (comm.response === 'interested') {
        display_status = 'Interested';
      } else if (comm.response === 'not_interested') {
        display_status = 'Not Interested';
      } else if (comm.message && comm.message.trim() !== '' && comm.reply_date) {
        display_status = 'Replied';
      } else if (comm.status === 'sent') {
        display_status = 'Sent';
      }
      
      return {
        ...comm,
        subject: cleanedSubject,
        message: cleanedMessage,
        display_status,
        date: comm.sent_at || comm.reply_date || comm.responded_at
      };
    });

    // 5. Calculate summary
    const summary = {
      total: processedCommunications.length,
      sent: processedCommunications.filter(c => c.display_status === 'Sent').length,
      replied: processedCommunications.filter(c => c.display_status === 'Replied').length,
      interested: processedCommunications.filter(c => c.display_status === 'Interested').length,
      not_interested: processedCommunications.filter(c => c.display_status === 'Not Interested').length,
      last_activity: processedCommunications[0]?.date || null
    };

    res.json({
      success: true,
      data: processedCommunications,
      buyer_info: {
        buyer_id: buyer.buyer_id,
        company_name: buyer.company_name,
        country: buyer.country,
        product_name: buyer.product_name,
        contact_name: buyer.contacts?.split(',')[0]?.trim() || 'N/A',
        email: buyer.emails?.split(',')[0]?.trim() || 'N/A',
        all_emails: buyer.emails,
        all_contacts: buyer.contacts
      },
      summary: summary,
      pagination: {
        total: total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
      }
    });

  } catch (err) {
    console.error('GET /api/tracking/buyer/:buyerId error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ==================== SEARCH BUYER COMMUNICATIONS (WITH PAGINATION) ====================
app.get('/api/tracking/buyer/:buyerId/search', async (req, res) => {
  const { buyerId } = req.params;
  const { sellerId, search = '', page = 1, limit = 10 } = req.query;

  if (!buyerId) {
    return res.status(400).json({
      success: false,
      message: 'buyerId is required'
    });
  }

  if (!sellerId) {
    return res.status(400).json({
      success: false,
      message: 'sellerId is required'
    });
  }

  try {
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    // Build search conditions - using actual database columns
    let whereConditions = ['buyer_id = ?', 'seller_id = ?'];
    let params = [buyerId, sellerId];

    if (search && search.trim() !== '') {
      const searchPattern = `%${search}%`;
      whereConditions.push(`(
        subject LIKE ? OR 
        message LIKE ? OR 
        response LIKE ? OR 
        template_used LIKE ? OR 
        company_name LIKE ? OR
        to_email LIKE ? OR
        contact_name LIKE ?
      )`);
      params.push(
        searchPattern, 
        searchPattern, 
        searchPattern, 
        searchPattern, 
        searchPattern, 
        searchPattern,
        searchPattern
      );
    }

    const whereClause = `WHERE ${whereConditions.join(' AND ')}`;

    // Get total count with search
    const countQuery = `
      SELECT COUNT(*) as total
      FROM email_history_companies
      ${whereClause}
    `;
    const [countResult] = await pool.query(countQuery, params);
    const total = countResult[0]?.total || 0;

    // Get paginated search results
    const query = `
      SELECT 
        id,
        buyer_id,
        batch_id,
        company_name,
        country,
        contact_name,
        email as from_email,
        to_email,
        subject,
        message,
        product_name,
        sent_at,
        reply_date,
        responded_at,
        status,
        template_used,
        response,
        seller_id,
        'email' as record_type,
        COALESCE(sent_at, reply_date, responded_at) as date
      FROM email_history_companies
      ${whereClause}
      ORDER BY COALESCE(sent_at, reply_date, responded_at) DESC
      LIMIT ? OFFSET ?
    `;

    const queryParams = [...params, limitNum, offset];
    const [communications] = await pool.query(query, queryParams);

    // Process communications and add display_status
    const processedCommunications = communications.map(comm => {
      let cleanedSubject = comm.subject || '';
      let cleanedMessage = comm.message || '';
      
      cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
      cleanedSubject = cleanedSubject.replace(/^Re:\s*/i, '');
      
      if (cleanedMessage) {
        const onIndex = cleanedMessage.indexOf('\nOn ');
        if (onIndex !== -1) {
          cleanedMessage = cleanedMessage.substring(0, onIndex).trim();
        }
        const wroteIndex = cleanedMessage.indexOf('wrote:');
        if (wroteIndex !== -1) {
          cleanedMessage = cleanedMessage.substring(0, wroteIndex).trim();
        }
        cleanedMessage = cleanedMessage
          .replace(/\\u003C/g, '<')
          .replace(/\\u003E/g, '>')
          .replace(/\[[^\]]*\]/g, '')
          .replace(/https?:\/\/[^\s]+/g, '')
          .replace(/\n\s*\n\s*\n/g, '\n\n')
          .trim();
      }
      
      let display_status = 'Unknown';
      if (comm.response === 'interested') {
        display_status = 'Interested';
      } else if (comm.response === 'not_interested') {
        display_status = 'Not Interested';
      } else if (comm.message && comm.message.trim() !== '' && comm.reply_date) {
        display_status = 'Replied';
      } else if (comm.status === 'sent') {
        display_status = 'Sent';
      }
      
      return {
        ...comm,
        subject: cleanedSubject,
        message: cleanedMessage,
        display_status,
        date: comm.sent_at || comm.reply_date || comm.responded_at
      };
    });

    // Calculate summary
    const summary = {
      total: processedCommunications.length,
      sent: processedCommunications.filter(c => c.display_status === 'Sent').length,
      replied: processedCommunications.filter(c => c.display_status === 'Replied').length,
      interested: processedCommunications.filter(c => c.display_status === 'Interested').length,
      not_interested: processedCommunications.filter(c => c.display_status === 'Not Interested').length,
      last_activity: processedCommunications[0]?.date || null
    };

    // Get buyer info
    const [buyerInfo] = await pool.query(`
      SELECT 
        b.id as buyer_id,
        b.company_name,
        b.country,
        b.product as product_name,
        GROUP_CONCAT(DISTINCT bc.contact_number SEPARATOR ', ') as contacts,
        GROUP_CONCAT(DISTINCT be.email SEPARATOR ', ') as emails
      FROM buyers b
      LEFT JOIN buyer_contacts bc ON b.id = bc.buyer_id
      LEFT JOIN buyer_emails be ON b.id = be.buyer_id
      WHERE b.id = ?
      GROUP BY b.id
    `, [buyerId]);

    const buyer = buyerInfo[0] || {};

    res.json({
      success: true,
      data: processedCommunications,
      buyer_info: {
        buyer_id: buyer.buyer_id,
        company_name: buyer.company_name || 'Unknown',
        country: buyer.country || 'Unknown',
        product_name: buyer.product_name || 'Unknown',
        contact_name: buyer.contacts?.split(',')[0]?.trim() || 'N/A',
        email: buyer.emails?.split(',')[0]?.trim() || 'N/A',
        all_emails: buyer.emails || '',
        all_contacts: buyer.contacts || ''
      },
      summary: summary,
      pagination: {
        total: total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
      },
      search: search || null
    });

  } catch (err) {
    console.error('GET /api/tracking/buyer/:buyerId/search error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
app.get('/track-response', async (req, res) => {
  const { batchId, email, response } = req.query;

  // ✅ Step 1: Log exactly what came in
  console.log('📩 /track-response hit:', { batchId, email, response });

  // ✅ Step 2: Validation check
  if (!batchId || !email || !['interested', 'not_interested'].includes(response)) {
    console.log('❌ Validation failed:', { batchId, email, response });
    return res.status(400).send(`
      <html><body style="font-family:Arial;text-align:center;padding:60px;">
        <h2>❌ Invalid Request</h2>
        <p>batchId: ${batchId}</p>
        <p>email: ${email}</p>
        <p>response: ${response}</p>
      </body></html>
    `);
  }

  try {
    // ✅ Step 3: Check if record exists at all
    const [existing] = await pool.query(
      `SELECT id, email, response, from_email, status FROM email_history_companies 
       WHERE batch_id = ? AND email = ?`,
      [batchId, email]
    );

    console.log('🔍 DB lookup result:', existing);

    // ✅ Step 4: Record not found at all
    if (existing.length === 0) {
      console.log('❌ No record found for:', { batchId, email });
      return res.status(404).send(`
        <html><body style="font-family:Arial;text-align:center;padding:60px;">
          <h2>❌ Record Not Found</h2>
          <p>No record found for batchId: <strong>${batchId}</strong></p>
          <p>email: <strong>${email}</strong></p>
          <p>Check if the email was inserted into email_history_companies table.</p>
        </body></html>
      `);
    }

    // ✅ Step 5: Already responded
    if (existing[0].response !== null) {
      return res.send(`
        <html><body style="font-family:Arial;text-align:center;padding:60px;">
          <h2>⚠️ Already Responded</h2>
          <p>Your answer: <strong>${existing[0].response.replace('_', ' ')}</strong></p>
        </body></html>
      `);
    }

    // ✅ Step 6: Update with from_email and to_email - WITHOUT touching the status column
    const yourEmail = process.env.EMAIL_USER;
    
    const [updateResult] = await pool.query(
      `UPDATE email_history_companies
       SET response = ?, 
           responded_at = NOW(),
           from_email = ?,
           to_email = ?
       WHERE batch_id = ? AND email = ?`,
      [response, email, yourEmail, batchId, email]
    );

    console.log('✅ Update result:', updateResult);

    // ✅ Step 7: Check if update actually affected a row
    if (updateResult.affectedRows === 0) {
      console.log('❌ Update ran but affected 0 rows');
      return res.status(500).send(`
        <html><body style="font-family:Arial;text-align:center;padding:60px;">
          <h2>❌ Update Failed</h2>
          <p>Query ran but no rows were updated.</p>
          <p>batchId: ${batchId} | email: ${email}</p>
        </body></html>
      `);
    }

    const label = response === 'interested' ? '✅ Interested' : '❌ Not Interested';
    const color = response === 'interested' ? '#22c55e' : '#ef4444';

    return res.send(`
      <html><body style="font-family:Arial;text-align:center;padding:60px;">
        <h2 style="color:${color};">${label}</h2>
        <p>Thank you! Your response has been recorded.</p>
      </body></html>
    `);

  } catch (err) {
    console.error('💥 track-response error:', err);
    return res.status(500).send(`
      <html><body style="font-family:Arial;text-align:center;padding:60px;">
        <h2>💥 Server Error</h2>
        <p><strong>${err.message}</strong></p>
        <pre style="text-align:left;background:#f3f4f6;padding:16px;">${err.stack}</pre>
      </body></html>
    `);
  }
});


app.post("/api/email-configurations", async (req, res) => {
  try {
    const {
      profileName,
      provider,
      senderName,
      senderEmail,
      smtpHost,
      smtpPort,
      username,
      password,
      apiKey,
    } = req.body;

    const sql = `
      INSERT INTO email_profiles (
        profile_name,
        provider,
        sender_name,
        sender_email,
        smtp_host,
        smtp_port,
        username,
        password,
        api_key
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const [result] = await pool.execute(sql, [
      profileName,
      provider,
      senderName,
      senderEmail,
      smtpHost || null,
      smtpPort || null,
      username || null,
      password || null,
      apiKey || null,
    ]);

    res.status(201).json({
      success: true,
      message: "Email configuration saved successfully",
      id: result.insertId,
    });
  } catch (error) {
    console.error("Email configuration error:", error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});




app.post("/api/seller/login", async (req, res) => {
   console.log(req.body);
  try {
    const { email, password } = req.body;
 console.log(req.body);
    // Validation
    if (!email || !password) {
      return res.status(400).json({
        status: false,
        message: "Email and password are required",
      });
    }

    // Fetch seller
    const [rows] = await pool.execute(
      "SELECT * FROM users WHERE email = ? AND role = ?",
      [email, "seller"]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        status: false,
        message: "Invalid Email or Password",
      });
    }

    const seller = rows[0];

    // Password check
    if (seller.password !== password) {
      return res.status(401).json({
        status: false,
        message: "Invalid Email or Password",
      });
    }

    // Generate token
    const token = jwt.sign(
      {
        id: seller.id,
        email: seller.email,
        role: seller.role,
      },
      process.env.JWT_SECRET || "SECRET_KEY",
      {
        expiresIn: "7d",
      }
    );

    res.json({
      status: true,
      message: "Login successful",
      token,
      seller: {
        id: seller.id,
        email: seller.email,
        role: seller.role,
      },
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      status: false,
      message: "Something went wrong",
    });
  }
});
app.post("/api/store-user", async (req, res) => {
  try {
const {
  id,
  email,
  password,
  role,
  name,
  phone,
  package_id
} = req.body;

    if (!id || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "id, email and password are required",
      });
    }

    // Check existing user based on ID
    const [existing] = await pool.execute(
      "SELECT user_id, id, email FROM users WHERE id = ?",
      [id]
    );

    if (existing.length > 0) {
      return res.status(200).json({
        success: true,
        exists: true,
        message: "User already exists",
        user_id: existing[0].user_id,
        id: existing[0].id,
        email: existing[0].email
      });
    }

    // User doesn't exist, insert new record
   const [result] = await pool.execute(
  `INSERT INTO users
  (
    id,
    email,
    password,
    role,
    name,
    phone_number,
    package_id,
    email_sent,
    email_config
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  [
    id,
    email,
    password,
    role || "seller",
    name,
    phone,
    package_id
  ]
);

    res.status(201).json({
  success: true,
  exists: false,
  message: "User stored successfully",
  user_id: result.insertId,
  id,
  email,
  role,
  name,
  phone,
  package_id
});

  } catch (err) {
    console.error('Error in /api/store-user:', err);

    // Handle duplicate entry error
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        message: "User with this ID already exists",
        error: err.message
      });
    }

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

app.get("/api/email-configurations/:sellerId", async (req, res) => {
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
ON ep.seller_id=u.id
WHERE ep.seller_id=?
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

app.put("/api/email-configurations/:sellerId", async (req, res) => {
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
        message:
          "profileName, provider, senderEmail, and username are required.",
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

app.post("/api/send-test-email/:sellerId", async (req, res) => {

    try {

        const { sellerId } = req.params;

        const [rows] = await pool.execute(
            `
            SELECT *
            FROM email_profiles
            WHERE seller_id=?
            LIMIT 1
            `,
            [sellerId]
        );

        if (rows.length == 0) {

            return res.json({
                success:false,
                message:"Email configuration not found."
            });

        }

        const config = rows[0];

        const transporter = nodemailer.createTransport({

            host: config.smtp_host,

            port: Number(config.smtp_port),

            secure: Number(config.smtp_port)===465,

            auth:{
                user:config.username,
                pass:config.password
            },
            tls:{
                rejectUnauthorized:false
            }

        });

        await transporter.sendMail({

            from:`${config.sender_name} <${config.sender_email}>`,

            to:config.sender_email,

            subject:"Test Email",

            html:`
            <h2>Email Configuration Successful</h2>

            <p>This is a test email.</p>

            <p>Your SMTP configuration is working correctly.</p>
            `

        });

        await pool.execute(

            `
            UPDATE users
            SET email_sent=1
            WHERE id=?
            `,
            [sellerId]

        );

        res.json({

            success:true,

            message:"Test email sent successfully."

        });

    }

    catch(err){

        console.log(err);

        res.json({

            success:false,

            message:err.message

        });

    }

});


// routes/email.js

app.get("/status/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const [rows] = await pool.query(
      `SELECT email_config, email_sent FROM users WHERE id = ?`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    res.json({
      success: true,
      data: rows[0]
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
});

app.use('/', buyerRoutes);
app.use('/', bulkBuyerRoutes);
app.use('/', userRoutes);
// app.use('/', ssoRouter);
/* ─────────────────────────────────────────────
   START SERVER
───────────────────────────────────────────── */
console.log('📧 Starting email reply monitor...');

checkForReplies();

setInterval(() => {
  checkForReplies();
}, 2 * 60 * 1000);

app.listen(5000, () => {
  console.log(`Server running on port 5000`);
  console.log(`Bull Board → http://localhost:5000/admin/queues`);
});