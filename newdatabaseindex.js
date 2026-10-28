const mysql = require("mysql2/promise");
const express = require("express");
const cors = require("cors");
const nodemailer = require('nodemailer');
const Bull = require('bull');
const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');
// const { checkForReplies } = require('./readReplies');
const jwt = require("jsonwebtoken");
require('dotenv').config();
const buyerroutes = require('./routes/buyerroutes');
const bulkbuyerroutes = require('./routes/bulkbuyerroutes');
const searchroutes = require('./routes/searchroutes');
const contactroutes = require('./routes/contactroutes');
const trackingroutes = require('./routes/trackingroutes');
const Historydetailroutes = require('./routes/historyDetailRoutes');
const emailroutes = require('./routes/emailconfigroutes');

const app = express();

app.use(cors());
app.use(express.json());

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
  // port:4306
});

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

    if (existing.length > 0) {
      await pool.query(
        `UPDATE email_history_companies 
         SET sent_at = ?, status = ?, template_used = ?, template_id = ?, 
             product_name = ?, multiple_products = ?, buyer_id = ?, seller_id = ?
         WHERE batch_id = ? AND email = ?`,
        [new Date(), sendStatus, company.templateUsed || 'Welcome Template',
         company.templateId, originalProduct, job.data.multipleProducts || false,
         company.buyer_id, sellerId, batchId, recipientEmail]
      );
    } else {
      await pool.query(
        `INSERT INTO email_history_companies
          (batch_id, seller_id, buyer_id, company_name, country, contact_name, email, 
           sent_at, status, template_used, template_id, product_name, multiple_products)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [batchId, sellerId, company.buyer_id, company.companyName || 'Unknown',
         company.country || null, company.contactName || company.companyName || 'Unknown',
         recipientEmail, new Date(), sendStatus, company.templateUsed || 'Welcome Template',
         company.templateId, originalProduct, job.data.multipleProducts || false]
      );
    }
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

/* ─────────────────────────────────────────────
   /send-email — fetch profile, enqueue jobs
───────────────────────────────────────────── */

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

app.get("/buyers", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);

    const search = req.query.search || "";
    const country = req.query.country || "";
    const product = req.query.product || "";

    let where = [];
    let values = [];

    if (search) {
      where.push(`(
        b.company_name LIKE ?
        OR b.country LIKE ?
        OR b.product LIKE ?
        OR b.hsn_code LIKE ?
        OR b.website LIKE ?
      )`);
      values.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (country) {
      where.push(`b.country = ?`);
      values.push(country);
    }

    if (product) {
      where.push(`b.product = ?`);
      values.push(product);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      SELECT
        b.id AS buyer_id,
        b.buyer_date,
        b.product,
        b.hsn_code,
        b.country,
        b.company_name,
        b.website,
        GROUP_CONCAT(DISTINCT bc.contact_number SEPARATOR ', ') AS contacts,
        GROUP_CONCAT(DISTINCT be.email SEPARATOR ', ') AS emails
      FROM buyers b
      LEFT JOIN buyer_contacts bc ON b.id = bc.buyer_id
      LEFT JOIN buyer_emails be ON b.id = be.buyer_id
      ${whereClause}
      GROUP BY b.id
      ORDER BY b.id DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await pool.query(sql, [...values, limit, offset]);
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM buyers b ${whereClause}`,
      values
    );

    res.json({ data: rows, total: countRows[0].total });

  } catch (err) {
    console.error("GET /buyers ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

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
    seller_id
  } = req.body;

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
         from_email, to_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, 'responded', ?, ?)`,
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

app.get('/api/admin/history', async (req, res) => {
  console.log('GET /api/admin/history called');
  
  try {
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

    const cleanedResults = results.map(row => {
      let cleanedMessage = row.message;
      
      if (cleanedMessage) {
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
          const parts = cleanedMessage.split(/\n\s*\n\s*\n/);
          if (parts.length > 0) {
            cleanedMessage = parts[0].trim();
          }
        }
        
        cleanedMessage = cleanedMessage.split('\n')
          .filter(line => !line.trim().startsWith('>'))
          .join('\n')
          .trim();
        
        cleanedMessage = cleanedMessage
          .replace(/\\u003C/g, '<')
          .replace(/\\u003E/g, '>')
          .replace(/\[[^\]]*\]/g, '')
          .replace(/https?:\/\/[^\s]+/g, '')
          .trim();
      }
      
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

app.get('/history', async (req, res) => {
  const { seller_id } = req.query;
  console.log('GET /history called with seller_id:', seller_id);
  
  if (!seller_id) {
    return res.status(400).json({ error: 'seller_id is required' });
  }

  try {
    const [batches] = await pool.query(`
      SELECT DISTINCT
        batch_id,
        MAX(product_name) as product_name,
        MAX(sent_at) as sent_at,
        MAX(multiple_products) as multiple_products,
        MAX(CASE WHEN template_used IS NOT NULL THEN template_used END) as template_used
      FROM email_history_companies
      WHERE seller_id = ?
      GROUP BY batch_id
      ORDER BY MAX(sent_at) DESC
    `, [seller_id]);

    const historyData = await Promise.all(
      batches.map(async (batch) => {
        const [results] = await pool.query(
          `
          SELECT
            batch_id AS id,
            product_name AS product,
            company_name,
            contact_name,
            email,
            sent_at,
            status,
            response,
            responded_at,
            template_used,
            message,
            reply_date,
            subject
          FROM email_history_companies
          WHERE batch_id = ? AND seller_id = ?
          ORDER BY sent_at DESC
          `,
          [batch.batch_id, seller_id]
        );

        if (!results.length) return null;

        const counts = {
          total: results.length,
          replied: results.filter(row => row.message && row.message.trim() !== '').length,
          interested: results.filter(row => row.response === 'interested').length,
          notInterested: results.filter(row => row.response === 'not_interested').length,
          emailSent: results.filter(row => row.status === 'sent' || row.response === null).length
        };

        const companies = results.map((row) => {
          let displayStatus = 'Email Sent';

          const hasMessage = row.message && row.message.trim() !== '';
          const isInterested = row.response === 'interested';
          const isNotInterested = row.response === 'not_interested';

          if (hasMessage && isInterested) {
            displayStatus = 'Replied, Interested';
          } else if (hasMessage && isNotInterested) {
            displayStatus = 'Replied, Not Interested';
          } else if (hasMessage) {
            displayStatus = 'Replied';
          } else if (isInterested) {
            displayStatus = 'Interested';
          } else if (isNotInterested) {
            displayStatus = 'Not Interested';
          }

          let cleanedMessage = null;
          let cleanedSubject = row.subject;
          
          if (row.message && row.message.trim() !== '') {
            const firstLine = row.message.split('\n')[0];
            cleanedMessage = firstLine.trim();
          }

          return {
            companyName: row.company_name,
            contactName: row.contact_name,
            email: row.email,
            sentAt: row.sent_at,
            response: row.response,
            respondedAt: row.reply_date || row.responded_at,
            status: displayStatus,
            templateUsed: row.template_used,
            subject: cleanedSubject,
            message: cleanedMessage,
            product: row.product,
            hasReply: hasMessage,
            isInterested: isInterested,
            isNotInterested: isNotInterested
          };
        });

        let mainProduct = results[0]?.product || batch.product_name;
        if (batch.multiple_products === 1) {
          mainProduct = "General Products";
        }

        return {
          id: batch.batch_id,
          product: mainProduct,
          multiple_products: batch.multiple_products,
          date: batch.sent_at,
          companies,
          counts,
          summary: {
            hasInterested: counts.interested > 0,
            hasReplied: counts.replied > 0,
            hasNotInterested: counts.notInterested > 0,
            allSent: counts.emailSent === counts.total,
            allReplied: counts.replied === counts.total
          }
        };
      })
    );

    const filteredData = historyData.filter(item => item !== null);
    
    const uniqueData = filteredData.reduce((acc, current) => {
      const existing = acc.find(item => item.id === current.id);
      if (!existing) {
        acc.push(current);
      }
      return acc;
    }, []);

    uniqueData.sort((a, b) => {
      const dateCompare = new Date(b.date) - new Date(a.date);
      if (dateCompare !== 0) return dateCompare;
      
      if (a.counts.interested > 0 && b.counts.interested === 0) return -1;
      if (a.counts.interested === 0 && b.counts.interested > 0) return 1;
      
      return 0;
    });

    res.json({
      success: true,
      total: uniqueData.length,
      data: uniqueData
    });

  } catch (err) {
    console.error('GET /history error:', err);
    res.status(500).json({ error: err.message });
  }
});

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

app.get('/history/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [results] = await pool.query(
      `
      SELECT
        batch_id AS id,
        product_name AS product,
        company_name,
        contact_name,
        email,
        sent_at,
        status,
        response,
        responded_at,
        template_used,
        message,
        reply_date,
        subject,
        multiple_products
      FROM email_history_companies
      WHERE batch_id = ?
      ORDER BY sent_at DESC
      `,
      [id]
    );

    console.log(`Found ${results.length} records for batch ${id}`);

    if (!results.length) {
      return res.status(404).json({
        success: false,
        message: 'History not found'
      });
    }

    const counts = {
      total: results.length,
      replied: 0,
      interested: 0,
      notInterested: 0,
      emailSent: 0
    };

    results.forEach((row) => {
      if (row.message && row.message.trim() !== '') {
        counts.replied++;
      }
      if (row.response === 'interested') {
        counts.interested++;
      }
      if (row.response === 'not_interested') {
        counts.notInterested++;
      }
      if (row.status === 'sent' || row.response === null) {
        counts.emailSent++;
      }
    });

    const companies = results.map((row) => {
      let displayStatus = 'Email Sent';

      const hasMessage = row.message && row.message.trim() !== '';
      const isInterested = row.response === 'interested';
      const isNotInterested = row.response === 'not_interested';

      if (hasMessage && isInterested) {
        displayStatus = 'Replied, Interested';
      } else if (hasMessage && isNotInterested) {
        displayStatus = 'Replied, Not Interested';
      } else if (hasMessage) {
        displayStatus = 'Replied';
      } else if (isInterested) {
        displayStatus = 'Interested';
      } else if (isNotInterested) {
        displayStatus = 'Not Interested';
      }

      let cleanedMessage = null;
      let cleanedSubject = row.subject;
      
      if (row.message && row.message.trim() !== '') {
        const firstLine = row.message.split('\n')[0];
        cleanedMessage = firstLine.trim();
      }

      return {
        companyName: row.company_name,
        contactName: row.contact_name,
        email: row.email,
        sentAt: row.sent_at,
        response: row.response,
        respondedAt: row.reply_date || row.responded_at,
        status: displayStatus,
        templateUsed: row.template_used,
        subject: cleanedSubject,
        message: cleanedMessage,
        product: row.product,
        hasReply: hasMessage,
        isInterested: isInterested,
        isNotInterested: isNotInterested
      };
    });

    const multipleProducts = results[0].multiple_products;

    let mainProduct = results[0].product;
    if (multipleProducts === 1) {
      mainProduct = "General Products";
    }

    res.json({
      id: results[0].id,
      product: mainProduct,
      multiple_products: multipleProducts,
      date: results[0].sent_at,
      companies,
      counts
    });

  } catch (err) {
    console.error('GET /history/:id error:', err);
    res.status(500).json({
      success: false,
      message: err.message
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

app.get('/api/tracking/counts', async (req, res) => {
  const { seller_id } = req.query;

  if (!seller_id) {
    return res.status(400).json({ success: false, error: 'seller_id is required' });
  }

  try {
    const [sentCount] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as count
      FROM email_history_companies
      WHERE status = 'sent'
        AND buyer_id IS NOT NULL
        AND seller_id = ?
    `, [seller_id]);

    const [repliedCount] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as count
      FROM email_history_companies
      WHERE message IS NOT NULL 
        AND message != ''
        AND reply_date IS NOT NULL
        AND buyer_id IS NOT NULL
        AND seller_id = ?
    `, [seller_id]);

    const [interestedCount] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as count
      FROM email_history_companies
      WHERE response = 'interested'
        AND buyer_id IS NOT NULL
        AND seller_id = ?
    `, [seller_id]);

    const [notInterestedCount] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as count
      FROM email_history_companies
      WHERE response = 'not_interested'
        AND buyer_id IS NOT NULL
        AND seller_id = ?
    `, [seller_id]);

    const [notContactedCount] = await pool.query(`
      SELECT COUNT(*) as count
      FROM buyers b
      WHERE NOT EXISTS (
        SELECT 1 FROM email_history_companies ehc 
        WHERE ehc.buyer_id = b.id AND ehc.seller_id = ?
      )
    `, [seller_id]);

    const [totalContacted] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as count
      FROM email_history_companies
      WHERE buyer_id IS NOT NULL
        AND seller_id = ?
    `, [seller_id]);

    res.json({
      success: true,
      data: {
        sent: sentCount[0].count,
        replied: repliedCount[0].count,
        interested: interestedCount[0].count,
        not_interested: notInterestedCount[0].count,
        not_contacted: notContactedCount[0].count
      },
      total: {
        all: totalContacted[0].count + notContactedCount[0].count
      }
    });

  } catch (err) {
    console.error('GET /api/tracking/counts error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/tracking/all', async (req, res) => {
  const { seller_id } = req.query;

  if (!seller_id) {
    return res.status(400).json({ success: false, error: 'seller_id is required' });
  }

  try {
    const [sentEmails] = await pool.query(`
      SELECT 
        buyer_id,
        MAX(company_name) as company_name,
        MAX(country) as country,
        MAX(contact_name) as contact_name,
        MAX(email) as email,
        MAX(template_used) as template_used,
        MAX(product_name) as product_name,
        COUNT(*) as interaction_count,
        MAX(sent_at) as last_interaction,
        'sent' as type,
        'sent' as current_status
      FROM email_history_companies
      WHERE status = 'sent'
        AND seller_id = ?
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
    `, [seller_id]);

    const [repliedEmails] = await pool.query(`
      SELECT 
        buyer_id,
        MAX(company_name) as company_name,
        MAX(country) as country,
        MAX(contact_name) as contact_name,
        MAX(email) as email,
        MAX(product_name) as product_name,
        COUNT(*) as interaction_count,
        MAX(reply_date) as last_interaction,
        'replied' as type,
        'replied' as current_status
      FROM email_history_companies
      WHERE message IS NOT NULL 
        AND message != ''
        AND reply_date IS NOT NULL
        AND seller_id = ?
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
    `, [seller_id]);

    const [interestedEmails] = await pool.query(`
      SELECT 
        buyer_id,
        MAX(company_name) as company_name,
        MAX(country) as country,
        MAX(contact_name) as contact_name,
        MAX(email) as email,
        MAX(product_name) as product_name,
        COUNT(*) as interaction_count,
        MAX(responded_at) as last_interaction,
        'interested' as type,
        'interested' as current_status
      FROM email_history_companies
      WHERE response = 'interested'
        AND seller_id = ?
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
    `, [seller_id]);

    const [notInterestedEmails] = await pool.query(`
      SELECT 
        buyer_id,
        MAX(company_name) as company_name,
        MAX(country) as country,
        MAX(contact_name) as contact_name,
        MAX(email) as email,
        MAX(product_name) as product_name,
        COUNT(*) as interaction_count,
        MAX(responded_at) as last_interaction,
        'not_interested' as type,
        'not_interested' as current_status
      FROM email_history_companies
      WHERE response = 'not_interested'
        AND seller_id = ?
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
    `, [seller_id]);

    const [notContacted] = await pool.query(`
      SELECT DISTINCT
        b.id as buyer_id,
        b.company_name,
        b.country,
        b.product as product_name,
        b.hsn_code,
        GROUP_CONCAT(DISTINCT be.email SEPARATOR ', ') as email,
        GROUP_CONCAT(DISTINCT bc.contact_number SEPARATOR ', ') as contact_name,
        0 as interaction_count,
        NULL as last_interaction,
        'not_contacted' as type,
        'not_contacted' as current_status
      FROM buyers b
      LEFT JOIN buyer_emails be ON b.id = be.buyer_id
      LEFT JOIN buyer_contacts bc ON b.id = bc.buyer_id
      WHERE NOT EXISTS (
        SELECT 1 FROM email_history_companies ehc 
        WHERE ehc.buyer_id = b.id AND ehc.seller_id = ?
      )
      GROUP BY b.id
      ORDER BY b.company_name
    `, [seller_id]);

    const [detailedCounts] = await pool.query(`
      SELECT 
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as total_sent,
        SUM(CASE WHEN message IS NOT NULL AND message != '' AND reply_date IS NOT NULL THEN 1 ELSE 0 END) as total_replied,
        SUM(CASE WHEN response = 'interested' THEN 1 ELSE 0 END) as total_interested,
        SUM(CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END) as total_not_interested
      FROM email_history_companies
      WHERE seller_id = ?
    `, [seller_id]);

    const [uniqueBuyerCounts] = await pool.query(`
      SELECT 
        COUNT(DISTINCT CASE WHEN status = 'sent' THEN buyer_id END) as unique_sent_buyers,
        COUNT(DISTINCT CASE WHEN message IS NOT NULL AND message != '' AND reply_date IS NOT NULL THEN buyer_id END) as unique_replied_buyers,
        COUNT(DISTINCT CASE WHEN response = 'interested' THEN buyer_id END) as unique_interested_buyers,
        COUNT(DISTINCT CASE WHEN response = 'not_interested' THEN buyer_id END) as unique_not_interested_buyers
      FROM email_history_companies
      WHERE seller_id = ?
    `, [seller_id]);

    const [notContactedCount] = await pool.query(`
      SELECT COUNT(DISTINCT b.id) as count
      FROM buyers b
      WHERE NOT EXISTS (
        SELECT 1 FROM email_history_companies ehc 
        WHERE ehc.buyer_id = b.id AND ehc.seller_id = ?
      )
    `, [seller_id]);

    res.json({
      success: true,
      data: {
        sent: sentEmails,
        replied: repliedEmails,
        interested: interestedEmails,
        not_interested: notInterestedEmails,
        notContacted: notContacted
      },
      counts: {
        totalSent: detailedCounts[0]?.total_sent || 0,
        totalReplied: detailedCounts[0]?.total_replied || 0,
        totalInterested: detailedCounts[0]?.total_interested || 0,
        totalNotInterested: detailedCounts[0]?.total_not_interested || 0,
        totalNotContacted: notContactedCount[0]?.count || 0,
        
        uniqueBuyers: {
          sent: uniqueBuyerCounts[0]?.unique_sent_buyers || 0,
          replied: uniqueBuyerCounts[0]?.unique_replied_buyers || 0,
          interested: uniqueBuyerCounts[0]?.unique_interested_buyers || 0,
          not_interested: uniqueBuyerCounts[0]?.unique_not_interested_buyers || 0,
          not_contacted: notContactedCount[0]?.count || 0
        }
      }
    });

  } catch (err) {
    console.error('GET /api/tracking/all error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tracking/buyer/:id', async (req, res) => {
  const buyerId = req.params.id;
  const sellerId = req.query.sellerId;
  
  try {
    if (!sellerId) {
      return res.status(400).json({ 
        success: false, 
        message: 'sellerId is required' 
      });
    }

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

app.get('/track-response', async (req, res) => {
  const { batchId, email, response } = req.query;

  console.log('📩 /track-response hit:', { batchId, email, response });

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
    const [existing] = await pool.query(
      `SELECT id, email, response, from_email, status FROM email_history_companies 
       WHERE batch_id = ? AND email = ?`,
      [batchId, email]
    );

    console.log('🔍 DB lookup result:', existing);

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

    if (existing[0].response !== null) {
      return res.send(`
        <html><body style="font-family:Arial;text-align:center;padding:60px;">
          <h2>⚠️ Already Responded</h2>
          <p>Your answer: <strong>${existing[0].response.replace('_', ' ')}</strong></p>
        </body></html>
      `);
    }

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

    if (!email || !password) {
      return res.status(400).json({
        status: false,
        message: "Email and password are required",
      });
    }

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

    if (seller.password !== password) {
      return res.status(401).json({
        status: false,
        message: "Invalid Email or Password",
      });
    }

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
    const { id, email, password, role } = req.body;

    if (!id || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "id, email and password are required",
      });
    }

    const [existing] = await pool.execute(
      "SELECT user_id FROM users WHERE email = ?",
      [email]
    );

    if (existing.length > 0) {
      return res.status(200).json({
        success: true,
        exists: true,
        message: "User already exists",
      });
    }

    const [result] = await pool.execute(
      `INSERT INTO users
      (id, email, password, role, email_sent, email_config)
      VALUES (?, ?, ?, ?, 0, 0)`,
      [
        id,
        email,
        password,
        role || "seller"
      ]
    );

    res.json({
      success: true,
      message: "User stored successfully",
      user_id: result.insertId,
      id,
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

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

/* ─────────────────────────────────────────────
   MOUNT ROUTERS  ← FIXED HERE
───────────────────────────────────────────── */

app.use('/', buyerroutes);
app.use('/', bulkbuyerroutes);
app.use('/', searchroutes);          // ✅ was: searchroutes(pool)
app.use('/', contactroutes);
app.use('/', trackingroutes);
app.use('/', Historydetailroutes);
app.use('/', emailroutes);

/* ─────────────────────────────────────────────
   START SERVER
───────────────────────────────────────────── */
console.log('📧 Starting email reply monitor...');

app.listen(5000, () => {
  console.log(`Server running on port 5000`);
  console.log(`Bull Board → http://localhost:5000/admin/queues`);
});