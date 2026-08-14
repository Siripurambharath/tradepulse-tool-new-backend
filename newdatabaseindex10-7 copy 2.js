const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
 const session = require('express-session');

const nodemailer = require('nodemailer');
const Bull = require('bull');
const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { checkForReplies } = require('./readReplies');
const jwt = require("jsonwebtoken");
require('dotenv').config();
const buyerRoutes = require('./routes/buyerroutes');
const ssoRouter = require('./routes/ssoRoute');
const templates = require('./routes/templates');
const historyDetailRoutes = require('./routes/historyDetailRoutes');
const bulkBuyerRoutes = require('./routes/bulkbuyerroutes'); 
const userRoutes = require('./routes/UsersRoutes');
const trackingroutes = require('./routes/trackingroutes');
const contactroutes = require('./routes/contactroutes');
const emailconfigroutes = require('./routes/emailconfigroutes');

const app = express();

const allowedOrigins = [
  'https://test-buyers.globpulse.com',
  'https://buyers.globpulse.com',
  'https://gfe-seller-dashboard.com'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());



app.use(session({
  secret: process.env.SESSION_SECRET || 'replace-with-a-strong-random-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,       // requires HTTPS — needed since you're cross-domain
    httpOnly: true,
    sameSite: 'none',   // required for cross-domain cookies to be sent/set
    maxAge: 24 * 60 * 60 * 1000, // 1 day, adjust as needed
  },
}));
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
         contactValue,  
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


app.get("/api/:id/package", async (req, res) => {
  try {
    const sellerId = String(req.params.id).trim();

    console.log("Fetching package info for seller:", sellerId);

    // 1. Local DB - usage only
    const [userRows] = await pool.query(
      `SELECT
          id,
          name,
          package_expire,
          phone_used,
          email_used
       FROM users
       WHERE id = ?`,
      [sellerId]
    );

    if (userRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Seller not found in local database",
      });
    }

    const user = userRows[0];

    // 2. Remote DB - seller package and plan_expiry_date
    const [sellerRows] = await remotePool.query(
      `SELECT 
          id, 
          package_id,
          plan_expiry_date
       FROM sellers
       WHERE id = ?`,
      [sellerId]
    );

    if (sellerRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Seller not found in remote database",
      });
    }

    const remoteSeller = sellerRows[0];

    // Use plan_expiry_date from remote sellers table
    const planExpiryDate = remoteSeller.plan_expiry_date;
    const isExpired = !planExpiryDate || new Date(planExpiryDate) < new Date();

    if (!remoteSeller.package_id) {
      return res.json({
        success: true,
        data: {
          package_id: null,
          package_name: null,
          package_expire: user.package_expire || null,
          plan_expiry_date: planExpiryDate || null,
          is_expired: isExpired,
          buyer_contact_limit: null,
          phone_used: user.phone_used || 0,
          email_used: user.email_used || 0,
          phone_remaining: null,
          email_remaining: null,
        },
      });
    }

    // 3. Remote DB - package details
    const [pkgRows] = await remotePool.query(
      `SELECT
          id,
          package_name,
          buyer_contact_limit
       FROM tbl_package_membership
       WHERE id = ?`,
      [remoteSeller.package_id]
    );

    if (pkgRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Package not found",
      });
    }

    const pkg = pkgRows[0];

    const limit = pkg.buyer_contact_limit;
    const isUnlimited = limit === null;

    const phoneUsed = Number(user.phone_used || 0);
    const emailUsed = Number(user.email_used || 0);

    return res.json({
      success: true,
      data: {
        package_id: pkg.id,
        package_name: pkg.package_name,
        package_expire: user.package_expire || null,
        plan_expiry_date: planExpiryDate || null,
        is_expired: isExpired,
        buyer_contact_limit: limit,
        phone_used: phoneUsed,
        email_used: emailUsed,
        phone_remaining: isUnlimited ? null : Math.max(limit - phoneUsed, 0),
        email_remaining: isUnlimited ? null : Math.max(limit - emailUsed, 0),
      },
    });
  } catch (err) {
    console.error("Error fetching package info:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
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




// Add this helper function at the top of your server.js
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}




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
        ON c.batch_id = r.batch_id AND c.email = r.from_email  // ✅ Fixed - changed to batch_id
      WHERE r.batch_id = ?
      ORDER BY r.reply_date DESC
    `, [id]);

    res.json({ batchId: id, total: replies.length, replies });
  } catch (err) {
    console.error('GET /history/:id/replies error:', err);
    res.status(500).json({ error: err.message });
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
app.put("/api/store-user", async (req, res) => {
  try {
    console.log("=== UPSERT USER REQUEST STARTED ===");
    const {
      id,
      email,
      password,
      role,
      name,
      phone,
      package_id,
      pack_exp_date,
    } = req.body;

    if (!id || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "id, email and password are required",
      });
    }

    // Sanitize values
    const safeRole = role ?? "seller";
    const safeName = name ?? null;
    const safePhone = phone ?? null;
    const safePackageId = package_id ?? null;
    const safePackExpDate = pack_exp_date ?? null;

    // Check if user exists
    const [existing] = await pool.execute(
      "SELECT user_id FROM users WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      // User doesn't exist - INSERT
      console.log(`🆕 User not found, creating new user with ID: ${id}`);
      
      const [result] = await pool.execute(
        `INSERT INTO users
        (id, email, password, role, name, phone_number, package_id, package_expire, email_sent, email_config)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
        [id, email, password, safeRole, safeName, safePhone, safePackageId, safePackExpDate]
      );

      return res.status(201).json({
        success: true,
        message: "User created successfully",
        action: "inserted",
        user_id: result.insertId,
        id,
        email,
        role: safeRole,
        name: safeName,
        phone: safePhone,
        package_id: safePackageId,
        pack_exp_date: safePackExpDate,
      });
    }

    // User exists - UPDATE
    console.log(`✅ User found with ID: ${id}, updating...`);
    
    await pool.execute(
      `UPDATE users
       SET email = ?,
           password = ?,
           role = ?,
           name = ?,
           phone_number = ?,
           package_id = ?,
           package_expire = ?
       WHERE id = ?`,
      [email, password, safeRole, safeName, safePhone, safePackageId, safePackExpDate, id]
    );

    res.json({
      success: true,
      message: "User updated successfully",
      action: "updated",
      id,
      email,
      role: safeRole,
      name: safeName,
      phone: safePhone,
      package_id: safePackageId,
      pack_exp_date: safePackExpDate,
    });

  } catch (err) {
    console.error("Error in /api/store-user (PUT):", err);
    res.status(500).json({
      success: false,
      message: err.message,
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



app.get("/api/package/:sellerId", async (req, res) => {
  try {
    const { sellerId } = req.params;

    // Get package_id from sellers table
    const [sellerRows] = await remotePool.execute(
      "SELECT package_id FROM sellers WHERE id = ?",
      [sellerId]
    );

    if (!sellerRows.length) {
      return res.status(404).json({
        success: false,
        message: "Seller not found",
      });
    }

    const packageId = sellerRows[0].package_id;

    if (!packageId) {
      return res.status(404).json({
        success: false,
        message: "No package assigned to this seller",
      });
    }

    // Get package details
    const [packageRows] = await remotePool.execute(
      `SELECT id, package_name, buyer_contact_limit
       FROM tbl_package_membership
       WHERE id = ?`,
      [packageId]
    );

    if (!packageRows.length) {
      return res.status(404).json({
        success: false,
        message: "Package not found",
      });
    }

    res.json({
      success: true,
      data: packageRows[0],
    });

  } catch (err) {
    console.error("Error fetching package:", err);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: err.message,
    });
  }
});


app.use('/', buyerRoutes);
app.use('/', bulkBuyerRoutes);
app.use('/', userRoutes);
app.use('/', ssoRouter);
app.use('/', templates);
app.use('/', historyDetailRoutes);
app.use('/', trackingroutes);
app.use('/', contactroutes);
app.use('/', emailconfigroutes);


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