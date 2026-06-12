const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const nodemailer = require('nodemailer');
const Bull = require('bull');
const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { checkForReplies } = require('./readReplies');
require('dotenv').config();

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
});

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

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: { rejectUnauthorized: false },
});

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

          <!-- ✅ Tracking Buttons -->
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





async function dbInsertCompanyRow(batchId, company, status) {
  await pool.query(
    `INSERT INTO email_history_companies
      (batch_id, buyer_id, company_name, country, contact_name, email, sent_at, status, template_used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      batchId,
    company.buyer_id,
      company.companyName,
      company.country,     
      company.contactName,
      company.email,
      new Date(),
      status,
      company.templateUsed,
    ]
  );
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
  } = job.data;

  console.log(`Processing job for ${recipientEmail} in batch ${batchId}`);

 
  await job.progress(20);

const trackedSubject = `${subject || `Business Opportunity - ${product}`} [BATCH:${batchId}]`;

  let sendStatus = 'Sent';
  let sendError = null;
  let messageId = null;

  try {
    const BASE_URL = process.env.BASE_URL;
    const interestedUrl    = `${BASE_URL}/track-response?batchId=${batchId}&email=${encodeURIComponent(recipientEmail)}&response=interested`;
    const notInterestedUrl = `${BASE_URL}/track-response?batchId=${batchId}&email=${encodeURIComponent(recipientEmail)}&response=not_interested`;

    const info = await transporter.sendMail({
      from: `"Trade Platform" <${process.env.EMAIL_USER}>`,
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
    console.log(`✅ Sent to ${recipientEmail} [${messageId}]`);
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
             product_name = ?, multiple_products = ?, buyer_id = ?
         WHERE batch_id = ? AND email = ?`,
        [new Date(), sendStatus, company.templateUsed || 'Welcome Template', 
         company.templateId, originalProduct, job.data.multipleProducts || false,
         company.buyer_id, batchId, recipientEmail]  // ✅ Add buyer_id
      );
    } else {
      await pool.query(
        `INSERT INTO email_history_companies
          (batch_id, buyer_id, company_name, country, contact_name, email, 
           sent_at, status, template_used, template_id, product_name, multiple_products)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [batchId, company.buyer_id, company.companyName || 'Unknown', 
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
app.post('/send-email', async (req, res) => {
  const { product, subject, message, historyPayload } = req.body;
  console.log('Received /send-email request with payload:', req.body);
  console.log('═══════════════════════════════════════');
  console.log('📧 SEND EMAIL API - FULL REQUEST BODY');
  console.log('═══════════════════════════════════════');
  console.log(JSON.stringify(req.body, null, 2));

  
  if (!historyPayload) {
    return res.status(400).json({ error: 'historyPayload is required' });
  }

  const { id: batchId, date: batchDate, companies } = historyPayload;

  if (!batchId) {
    return res.status(400).json({ error: 'historyPayload.id (batchId) is required' });
  }

  if (!companies || companies.length === 0) {
    return res.status(400).json({ error: 'No recipients specified' });
  }

  try {
  

    console.log(`✅ Parent record created for batchId: ${batchId}`);

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
          templateId: company.templateId 
    },
    batchId,
    multipleProducts: req.body.multipleProducts || false,
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
    console.log(`Enqueued ${jobIds.length} jobs for batch ${batchId}`);
    res.json({ batchId, jobIds, total: jobIds.length });

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

/* ─────────────────────────────────────────────
   FILTERS
───────────────────────────────────────────── */

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

app.get('/history', async (req, res) => {
  try {
    const [batches] = await pool.query(`
      SELECT DISTINCT
        batch_id,
        MAX(product_name) as product_name,
        MAX(sent_at) as sent_at,
        MAX(multiple_products) as multiple_products,
        MAX(CASE WHEN template_used IS NOT NULL THEN template_used END) as template_used
      FROM email_history_companies
      GROUP BY batch_id
      ORDER BY MAX(sent_at) DESC
    `);

    // For each batch, get its companies data
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
          WHERE batch_id = ?
          ORDER BY sent_at DESC
          `,
          [batch.batch_id]
        );

        if (!results.length) return null;

        // Fix counts logic
        const counts = {
          total: results.length,
          replied: results.filter(row => row.message && row.message.trim() !== '').length,
          interested: results.filter(row => row.response === 'interested').length,
          notInterested: results.filter(row => row.response === 'not_interested').length,
          emailSent: results.filter(row => row.status === 'sent').length
        };

        const companies = results.map((row) => {
          let displayStatus = 'Email Sent';
          
          if (row.response === 'interested') {
            displayStatus = 'Interested';
          } else if (row.response === 'not_interested') {
            displayStatus = 'Not Interested';
          } else if (row.message && row.message.trim() !== '') {
            displayStatus = 'Replied';
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
            subject: row.subject,
            message: row.message,
            product: row.product
          };
        });

        // Determine main product display
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
          counts
        };
      })
    );

    // Filter out any null results and send response
    const filteredData = historyData.filter(item => item !== null);
    
    // Remove duplicates by batch_id
    const uniqueData = filteredData.reduce((acc, current) => {
      const existing = acc.find(item => item.id === current.id);
      if (!existing) {
        acc.push(current);
      }
      return acc;
    }, []);

    res.json(uniqueData);

  } catch (err) {
    console.error('GET /history error:', err);
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
    templateUsed ,
    buyer_id  
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
    const [result] = await pool.query(
      `INSERT INTO email_history_companies 
        (batch_id, buyer_id, company_name, country, contact_name, email, 
         response, responded_at, product_name, template_used, status,
         from_email, to_email)
       VALUES (?, ?, ?,?, ?, ?, ?, NOW(), ?, ?, 'responded', ?, ?)`,
      [
        batchId,
        buyer_id || null,
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

    // If any row in the batch contains a message
    counts.replied = results.some(
      row => row.message && row.message.trim() !== ''
    ) ? 1 : 0;

    results.forEach((row) => {
      if (row.response === 'interested') {
        counts.interested++;
      }

      if (row.response === 'not_interested') {
        counts.notInterested++;
      }

      if (row.status === 'sent') {
        counts.emailSent++;
      }
    });

    const companies = results.map((row) => {
      let displayStatus = 'Email Sent';

      if (row.message && row.message.trim() !== '') {
        displayStatus = 'Replied';
      } else if (row.response === 'interested') {
        displayStatus = 'Interested';
      } else if (row.response === 'not_interested') {
        displayStatus = 'Not Interested';
      }

      // Clean the message - take only the first line before any newline
      let cleanedMessage = row.message;
      let cleanedSubject = row.subject;
      
      if (row.message && row.message.trim() !== '') {
        // Get the first line only (before first newline)
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
        message: cleanedMessage,  // Will be "bharath new" only
        product: row.product
      };
    });

    // Get multiple_products value from first row (same for all in batch)
    const multipleProducts = results[0].multiple_products;

    // Determine main product display
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

app.get('/api/replyhistory', async (req, res) => {
  try {
    // Get only records that are either 'interested' OR have a reply (message is not null)
    const query = `
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
        MAX(COALESCE(reply_date, responded_at, sent_at)) as last_interaction
      FROM email_history_companies
      WHERE buyer_id IS NOT NULL
        AND (
          LOWER(response) = 'interested' 
          OR (message IS NOT NULL AND message != '')
        )
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
    `;

    const [groupedResults] = await pool.query(query);

    if (groupedResults.length === 0) {
      return res.status(404).json({ success: false, message: "No interested or replied contacts found" });
    }

    const cleanedResults = groupedResults.map(contact => {
      let cleanedProductName = contact.product_name || '';
      let cleanedTemplate = contact.template_used || '';
      
      const phoneNumber = contact.contact_name && contact.contact_name.match(/^\+?\d+$/) 
        ? contact.contact_name 
        : '';

      return {
        buyer_id: contact.buyer_id,
        contact_name: contact.contact_name || 'Unknown',
        from_email: contact.from_email || '',
        to_email: contact.to_email || '',
        company_name: contact.company_name || '',
        country: contact.country || '',
        product_name: cleanedProductName,
        template_used: cleanedTemplate,
        phone: phoneNumber,
        interaction_count: contact.interaction_count,
        status: contact.has_sent ? 'sent' : 'pending',
        response: contact.has_interested ? 'interested' : 'replied', // 'interested' or 'replied'
        last_interaction: contact.last_interaction
      };
    });

    res.json({ 
      success: true, 
      count: cleanedResults.length, 
      data: cleanedResults 
    });

  } catch (error) {
    console.error("Error fetching email replies:", error);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching email replies", 
      error: error.message 
    });
  }
});


// Get detailed history for a specific buyer
app.get('/api/replyhistory/:buyerId', async (req, res) => {
  try {
    const buyerId = req.params.buyerId;
    
    const query = `
      SELECT 
        id,
        batch_id,
        buyer_id,
        from_email,
        to_email,
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
      WHERE buyer_id = ?
      ORDER BY COALESCE(reply_date, responded_at, sent_at) DESC
    `;

    const [results] = await pool.query(query, [buyerId]);

    if (results.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: "Contact not found" 
      });
    }

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
        buyer_id: reply.buyer_id,
        from_email: reply.from_email,
        to_email: reply.to_email,
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
      data: cleanedResults 
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
app.get('/api/replyhistory/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const query = `
      SELECT 
        id,
        batch_id,
        from_email,
        to_email,
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
      WHERE id = ?
      LIMIT 1
    `;

    const [results] = await pool.query(query, [id]);

    if (results.length === 0) {
      return res.status(404).json({ success: false, message: "Email reply not found" });
    }

    const reply = results[0];

    let cleanedSubject = reply.subject || '';
    cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
    cleanedSubject = cleanedSubject.replace(/^Re:\s*/, '');

    let cleanedMessage = reply.message;
    const onIndex = cleanedMessage.indexOf('\nOn');
    if (onIndex !== -1) {
      cleanedMessage = cleanedMessage.substring(0, onIndex).trim();
    }

    cleanedMessage = cleanedMessage
      .replace(/\\u003C/g, '<')
      .replace(/\\u003E/g, '>')
      .trim();

    res.json({
      success: true,
      data: {
        id: reply.id,
        batch_id: reply.batch_id,
        from_email: reply.from_email,
        to_email: reply.to_email,
        subject: cleanedSubject,
        message: cleanedMessage,
        product_name: reply.product_name,
        reply_date: reply.reply_date,
        company_name: reply.company_name,
        contact_name: reply.contact_name,
        country: reply.country,
        status: reply.status,
        template_used: reply.template_used,
        response: reply.response,
        responded_at: reply.responded_at
      }
    });

  } catch (error) {
    console.error("Error fetching email reply:", error);
    res.status(500).json({ success: false, message: "Error fetching email reply", error: error.message });
  }
});


app.get('/api/tracking/counts', async (req, res) => {

  try {

    // 1. SENT count - unique companies that have at least one sent email
    const [sentCount] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as count
      FROM email_history_companies
      WHERE status = 'sent'
        AND buyer_id IS NOT NULL
    `);

    // 2. REPLIED count - unique companies that have at least one reply
    const [repliedCount] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as count
      FROM email_history_companies
      WHERE message IS NOT NULL 
        AND message != ''
        AND reply_date IS NOT NULL
        AND buyer_id IS NOT NULL
    `);

    // 3. INTERESTED count - unique companies that have at least one 'interested' response
    const [interestedCount] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as count
      FROM email_history_companies
      WHERE response = 'interested'
        AND buyer_id IS NOT NULL
    `);

    // 4. NOT INTERESTED count - unique companies that have at least one 'not_interested' response
    const [notInterestedCount] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as count
      FROM email_history_companies
      WHERE response = 'not_interested'
        AND buyer_id IS NOT NULL
    `);

    // 5. NOT CONTACTED count - buyers with no email history
    const [notContactedCount] = await pool.query(`
      SELECT COUNT(*) as count
      FROM buyers b
      WHERE NOT EXISTS (
        SELECT 1 FROM email_history_companies ehc 
        WHERE ehc.buyer_id = b.id
      )
    `);

    // 6. Total unique companies contacted (have any email history)
    const [totalContacted] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as count
      FROM email_history_companies
      WHERE buyer_id IS NOT NULL
    `);

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
  try {
    // 1. SENT - Group by buyer_id with interaction count
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
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
    `);

    // 2. REPLIED - Group by buyer_id with interaction count
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
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
    `);

    // 3. INTERESTED - Group by buyer_id with interaction count
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
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
    `);

    // 4. NOT INTERESTED - Group by buyer_id with interaction count
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
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
    `);

    // 5. NOT CONTACTED - Buyers with no email history
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
        WHERE ehc.buyer_id = b.id
      )
      GROUP BY b.id
      ORDER BY b.company_name
    `);

    // Get detailed counts (total interactions per status, not unique buyers)
    const [detailedCounts] = await pool.query(`
      SELECT 
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as total_sent,
        SUM(CASE WHEN message IS NOT NULL AND message != '' AND reply_date IS NOT NULL THEN 1 ELSE 0 END) as total_replied,
        SUM(CASE WHEN response = 'interested' THEN 1 ELSE 0 END) as total_interested,
        SUM(CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END) as total_not_interested
      FROM email_history_companies
    `);

    // Get unique buyer counts
    const [uniqueBuyerCounts] = await pool.query(`
      SELECT 
        COUNT(DISTINCT CASE WHEN status = 'sent' THEN buyer_id END) as unique_sent_buyers,
        COUNT(DISTINCT CASE WHEN message IS NOT NULL AND message != '' AND reply_date IS NOT NULL THEN buyer_id END) as unique_replied_buyers,
        COUNT(DISTINCT CASE WHEN response = 'interested' THEN buyer_id END) as unique_interested_buyers,
        COUNT(DISTINCT CASE WHEN response = 'not_interested' THEN buyer_id END) as unique_not_interested_buyers
      FROM email_history_companies
    `);

    // Get not contacted count
    const [notContactedCount] = await pool.query(`
      SELECT COUNT(DISTINCT b.id) as count
      FROM buyers b
      WHERE NOT EXISTS (
        SELECT 1 FROM email_history_companies ehc 
        WHERE ehc.buyer_id = b.id
      )
    `);

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
        // Total interactions (email counts)
        totalSent: detailedCounts[0]?.total_sent || 0,
        totalReplied: detailedCounts[0]?.total_replied || 0,
        totalInterested: detailedCounts[0]?.total_interested || 0,
        totalNotInterested: detailedCounts[0]?.total_not_interested || 0,
        totalNotContacted: notContactedCount[0]?.count || 0,
        
        // Unique buyer counts
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
  
  try {
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

    // 2. Get ALL communications for this buyer from email_history_companies
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
        'email' as record_type
      FROM email_history_companies
      WHERE buyer_id = ?
      ORDER BY COALESCE(sent_at, reply_date, responded_at) DESC
    `, [buyerId]);

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
      
      // Determine display status
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
        all_contacts: buyerInfo.contacts
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