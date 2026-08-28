const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const session = require('express-session');
const pool = require("./db");
const https = require("https");
const fs = require("fs");
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
const searchroutes = require('./routes/searchroutes');
const app = express();

const allowedOrigins = [
  'https://test-buyers.globpulse.com',
  'https://buyers.globpulse.com',
  'https://gfe-seller-dashboard.com',

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
// app.use(cors({
//   origin: function (origin, callback) {
//     console.log("Origin =>", origin);
//     callback(null, true);
//   },
//   credentials: true,
// }));
// app.use(express.json());

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

// const pool = mysql.createPool({
//   host: "localhost",
//   user: "root",
//   password: "",
//   database: "seller_buyer_dummy",
//   waitForConnections: true,
//   connectionLimit: 20,
// });


//const remotePool = mysql.createPool({
  //host: "89.116.20.241",
  //user: "b2buser",
  //password: "5-kFm?qpumuZWTwk9lXa",
  //database: "b2b",
  //waitForConnections: true,
  //connectionLimit: 5,

//});


app.use(express.json()); // Parses JSON bodies
app.use(express.urlencoded({ extended: true }));

const remotePool = mysql.createPool({
  host: "89.116.20.241", // Keep the same host unless it has changed
  user: "b2b_remote_user_b2b",
  password: "RK^D??9DSgX5Z=;B",
  database: "b2b_remote_db",
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

const transporterCache = new Map(); // profileId -> transporter

function getCachedTransporter(profile) {
  if (transporterCache.has(profile.id)) {
    return transporterCache.get(profile.id);
  }
  const transporter = createTransporterFromProfile(profile);
  transporterCache.set(profile.id, transporter);
  return transporter;
}

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
    cc = [],
    hasCc = false,
    showCc = false
  } = job.data;

  console.log(`Processing job for ${recipientEmail} in batch ${batchId} via profile ${emailProfile?.profile_name} (seller_id=${sellerId})`);
  console.log(`📞 Contact Number: ${company.contacts || 'Not provided'}`);
  console.log(`📦 HSN Code: ${company.hsn_code || 'Not provided'}`);

  if (hasCc && cc.length > 0) {
    console.log(`📋 CC recipients: ${cc.join(', ')}`);
  }

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
    const interestedUrl = `${BASE_URL}/track-response?batchId=${batchId}&email=${encodeURIComponent(recipientEmail)}&response=interested`;
    const notInterestedUrl = `${BASE_URL}/track-response?batchId=${batchId}&email=${encodeURIComponent(recipientEmail)}&response=not_interested`;

    const mailOptions = {
      from: `"${emailProfile.sender_name}" <${emailProfile.sender_email}>`,
      to: recipientEmail,
      cc: hasCc && cc.length > 0 ? cc.join(', ') : undefined,
      subject: trackedSubject,
      html: buildHtml(message, originalProduct, interestedUrl, notInterestedUrl),
      headers: {
        'X-Batch-ID': batchId,
        'X-Product': product,
        'Message-ID': `<${batchId}-${Date.now()}@yourdomain.com>`,
        'X-CC-Enabled': hasCc ? 'true' : 'false',
        'X-CC-Recipients': hasCc ? cc.join(', ') : '',
      },
    };

    console.log(`📧 Mail options:`, {
      to: mailOptions.to,
      cc: mailOptions.cc || 'None',
      subject: mailOptions.subject
    });

    const info = await transporter.sendMail(mailOptions);

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

    const contactValue = company.contacts || company.contact_number || company.contactName || company.companyName || 'Unknown';

    if (existing.length > 0) {
      await pool.query(
        `UPDATE email_history_companies
         SET sent_at = ?, status = ?, template_used = ?, template_id = ?,
             product_name = ?, multiple_products = ?, buyer_id = ?, seller_id = ?,
             contact_name = ?, hsn_code = ?,
             has_cc = ?, cc_emails = ?  -- ✅ NEW
         WHERE batch_id = ? AND email = ?`,
        [new Date(), sendStatus, company.templateUsed || 'Welcome Template',
        company.templateId, originalProduct, job.data.multipleProducts || false,
        company.buyer_id, sellerId,
          contactValue,
          company.hsn_code || '',
          hasCc ? 1 : 0, JSON.stringify(cc),  // ✅ NEW
          batchId, recipientEmail]
      );
    } else {
      await pool.query(
        `INSERT INTO email_history_companies
          (batch_id, seller_id, buyer_id, company_name, country, contact_name, email,
           sent_at, status, template_used, template_id, product_name, multiple_products, hsn_code,
           has_cc, cc_emails)  -- ✅ NEW
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [batchId, sellerId, company.buyer_id, company.companyName || 'Unknown',
          company.country || null,
          contactValue,
          recipientEmail, new Date(), sendStatus, company.templateUsed || 'Welcome Template',
          company.templateId, originalProduct, job.data.multipleProducts || false,
          company.hsn_code || '',
          hasCc ? 1 : 0, JSON.stringify(cc)  // ✅ NEW
        ]
      );
    }

    console.log(`💾 Stored contact in contact_name: ${contactValue}`);
    console.log(`💾 Stored hsn_code: ${company.hsn_code || 'Not provided'}`);
    console.log(`💾 Stored CC info: has_cc=${hasCc}, cc_emails=${JSON.stringify(cc)}`);

  } catch (dbErr) {
    console.error(`💾 Database error for ${recipientEmail}:`, dbErr.message);
  }

  if (sendError) throw sendError;

  return { recipientEmail, status: sendStatus, messageId, cc: hasCc ? cc : [] };
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

// app.post('/send-email', async (req, res) => {
//   const { product, subject, message, historyPayload, seller_id } = req.body;

//   console.log('═══════════════════════════════════════');
//   console.log('📧 SEND EMAIL API - FULL REQUEST BODY');
//   console.log('═══════════════════════════════════════');
//   console.log(JSON.stringify(req.body, null, 2));

//   if (!seller_id) {
//     return res.status(400).json({ error: 'seller_id is required' });
//   }

//   if (!historyPayload) {
//     return res.status(400).json({ error: 'historyPayload is required' });
//   }

//   const { id: batchId, companies } = historyPayload;

//   if (!batchId) {
//     return res.status(400).json({ error: 'historyPayload.id (batchId) is required' });
//   }

//   if (!companies || companies.length === 0) {
//     return res.status(400).json({ error: 'No recipients specified' });
//   }

//   // Fetch the seller's active email profile BEFORE enqueuing
//   let emailProfile;
//   try {
//     emailProfile = await getEmailProfileBySellerId(seller_id);
//     console.log(`📨 Using email profile: ${emailProfile.profile_name} (${emailProfile.sender_email})`);
//   } catch (err) {
//     console.error('Email profile fetch error:', err.message);
//     return res.status(404).json({ error: err.message });
//   }

//   try {
//     const jobs = await Promise.all(
//       companies.map((company, index) =>
//         emailQueue.add(
//           {
//             recipientEmail: company.email,
//             subject,
//             message,
//             product: product,
//             originalProduct: company.product,
//             company: {
//               ...company,
//               buyer_id: company.buyer_id,
//               templateId: company.templateId,
//               contacts: company.contacts || company.contact_number || '',  // Pass contacts
//               contactName: company.contactName || company.contacts || company.companyName || 'Unknown',
//                hsn_code: company.hsn_code || '',
//             },
//             batchId,
//             sellerId: seller_id,
//             multipleProducts: req.body.multipleProducts || false,
//             emailProfile,
//           },
//           {
//             attempts: 3,
//             backoff: { type: 'exponential', delay: 3000 },
//             removeOnComplete: false,
//             removeOnFail: false,
//             jobId: `${batchId}-${index}`,
//           }
//         )
//       )
//     );

//     const jobIds = jobs.map((j) => j.id.toString());
//     console.log(`Enqueued ${jobIds.length} jobs for batch ${batchId} using seller ${seller_id}`);
//     console.log(`📞 Contacts passed: ${companies.map(c => c.contacts).join(', ')}`);
//     res.json({ batchId, jobIds, total: jobIds.length });

//   } catch (err) {
//     console.error('Queue error:', err);
//     res.status(500).json({ error: 'Failed to enqueue jobs', details: err.message });
//   }
// });
app.post('/send-email', async (req, res) => {
  // ✅ NEW: Destructure cc and showCc from request body
  const {
    product,
    subject,
    message,
    historyPayload,
    seller_id,
    cc = [],           // ✅ NEW: CC emails array
    showCc = false     // ✅ NEW: CC flag
  } = req.body;

  console.log('═══════════════════════════════════════');
  console.log('📧 SEND EMAIL API - FULL REQUEST BODY');
  console.log('═══════════════════════════════════════');
  console.log(JSON.stringify(req.body, null, 2));

  // ✅ NEW: Validate CC emails
  if (showCc && cc && cc.length > 0) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalidEmails = cc.filter(email => !emailRegex.test(email));

    if (invalidEmails.length > 0) {
      console.error(`❌ Invalid CC emails: ${invalidEmails.join(', ')}`);
      return res.status(400).json({
        error: `Invalid CC email addresses: ${invalidEmails.join(', ')}`
      });
    }

    // Check for duplicates
    const uniqueCC = [...new Set(cc)];
    if (uniqueCC.length !== cc.length) {
      console.error('❌ Duplicate CC emails found');
      return res.status(400).json({
        error: 'Duplicate CC email addresses found'
      });
    }

    // Limit CC recipients (max 10)
    const MAX_CC = 10;
    if (cc.length > MAX_CC) {
      console.error(`❌ Too many CC recipients: ${cc.length}`);
      return res.status(400).json({
        error: `Maximum ${MAX_CC} CC recipients allowed`
      });
    }

    console.log(`📋 CC Recipients (${cc.length}): ${cc.join(', ')}`);
  }

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
              contacts: company.contacts || company.contact_number || '',
              contactName: company.contactName || company.contacts || company.companyName || 'Unknown',
              hsn_code: company.hsn_code || '',
            },
            batchId,
            sellerId: seller_id,
            multipleProducts: req.body.multipleProducts || false,
            emailProfile,
            // ✅ NEW: Pass CC information
            cc: showCc ? cc : [],
            hasCc: showCc && cc.length > 0,
            showCc: showCc
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

    // ✅ REMOVED: No need to store CC info separately

    // ✅ NEW: Enhanced response with CC info
    res.json({
      batchId,
      jobIds,
      total: jobIds.length,
      cc: showCc ? cc : [],
      hasCc: showCc && cc.length > 0,
      message: `Emails queued successfully for ${companies.length} recipients${showCc && cc.length > 0 ? ` with ${cc.length} CC recipients` : ''}`
    });

  } catch (err) {
    console.error('Queue error:', err);
    res.status(500).json({ error: 'Failed to enqueue jobs', details: err.message });
  }
});

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
        const hasCc = job.data?.hasCc || false;
        const ccEmails = job.data?.cc || [];

        return {
          jobId,
          email: job.data.recipientEmail,
          companyName: job.data.company?.companyName,
          state,
          progress: job._progress || 0,
          result: state === 'completed' ? job.returnvalue : null,
          reason: state === 'failed' ? job.failedReason : null,
          cc: ccEmails,
          hasCc: hasCc
        };
      })
    );

    const total = jobStatuses.length;
    const completed = jobStatuses.filter((j) => j.state === 'completed').length;
    const failed = jobStatuses.filter((j) => j.state === 'failed').length;
    const active = jobStatuses.filter((j) => j.state === 'active').length;
    const waiting = jobStatuses.filter((j) => ['waiting', 'delayed'].includes(j.state)).length;

    let ccInfo = { hasCc: false, ccEmails: [] };
    try {
      // Check if any job has CC
      const hasAnyCc = jobStatuses.some(j => j.hasCc === true);
      const allCcEmails = jobStatuses
        .filter(j => j.cc && j.cc.length > 0)
        .flatMap(j => j.cc);
      const uniqueCcEmails = [...new Set(allCcEmails)];

      ccInfo = {
        hasCc: hasAnyCc,
        ccEmails: uniqueCcEmails
      };
    } catch (err) {
      console.error('Error fetching CC info:', err);
    }

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
      hasCc: ccInfo.hasCc || false,
      ccEmails: ccInfo.ccEmails || []
    });

  } catch (err) {
    console.error('Batch status error:', err);
    res.status(500).json({ error: 'Failed to get batch status' });
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
app.use('/', searchroutes);

/* ─────────────────────────────────────────────
   START SERVER
───────────────────────────────────────────── */
console.log('📧 Starting email reply monitor...');

checkForReplies();

setInterval(() => {
  checkForReplies();
}, 2 * 60 * 1000);

// app.listen(5000, () => {
//   console.log(`Server running on port 5000`);
//   console.log(`Bull Board → http://localhost:5000/admin/queues`);
// });

// app.listen(5000, () => {
//   console.log("Server running on port 5000");
// });

const sslOptions = {
  key: fs.readFileSync('/etc/letsencrypt/live/buyers.globpulse.com/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/buyers.globpulse.com/fullchain.pem')
};

https.createServer(sslOptions, app).listen(7002, () => {
  console.log('HTTPS Server running on port 7002');
  console.log('Bull Board → https://buyers.globpulse.com:7002/admin/queues');
});