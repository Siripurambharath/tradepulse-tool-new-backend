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
      (batch_id, company_name, country, contact_name, email, sent_at, status, template_used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      batchId,
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
      html: buildHtml(message, product, interestedUrl, notInterestedUrl),
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

  // ✅ Insert/Update company record using historyRowId
  try {
const [existing] = await pool.query(
  `SELECT id FROM email_history_companies 
   WHERE batch_id = ? AND email = ?`,
  [batchId, recipientEmail]
);

    if (existing.length > 0) {
await pool.query(
  `UPDATE email_history_companies 
   SET sent_at = ?, status = ?, template_used = ?, product_name = ?
   WHERE batch_id = ? AND email = ?`,
  [new Date(), sendStatus, company.templateUsed || 'Welcome Template', product, batchId, recipientEmail]
);
      console.log(`📝 Updated record for ${recipientEmail}`);
    } else {
await pool.query(
  `INSERT INTO email_history_companies
    (batch_id, company_name, country, contact_name, email, sent_at, status, template_used, product_name)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [batchId, company.companyName || 'Unknown', company.country || null, company.contactName || company.companyName || 'Unknown', recipientEmail, new Date(), sendStatus, company.templateUsed || 'Welcome Template', product]
);
      console.log(`📝 Inserted record for ${recipientEmail}`);
    }

    await job.progress(100);
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
            product,
            company,
            batchId,
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

/* ─────────────────────────────────────────────
   EMAIL HISTORY
───────────────────────────────────────────── */

app.get('/history', async (req, res) => {
  try {
    // Change this query - remove email_history table
    const [results] = await pool.query(`
      SELECT 
        batch_id as id,
        product_name as product,
        sent_at as date,
        company_name,
        country,
        contact_name,
        email,
        sent_at,
        status,
        response,
        responded_at,
        template_used
      FROM email_history_companies
      ORDER BY sent_at DESC
    `);
    
    // Group by batch_id
    const historyMap = {};
    results.forEach((row) => {
      if (!historyMap[row.id]) {
        historyMap[row.id] = { id: row.id, product: row.product, date: row.date, companies: [] };
      }
      if (row.company_name) {
        historyMap[row.id].companies.push({
          companyName: row.company_name,
          contactName: row.contact_name,
          country: row.country,
          email: row.email,
          sentAt: row.sent_at,
          response: row.response,
          respondedAt: row.responded_at,
          status: row.status,
          templateUsed: row.template_used,
        });
      }
    });

    res.json(Object.values(historyMap));

  } catch (err) {
    console.error('GET /history error:', err);
    res.status(500).json({ error: err.message });
  }
});

// app.get('/history/:id', async (req, res) => {
//   try {
//     const { id } = req.params;

//     const [results] = await pool.query(`
//       SELECT h.id, h.product, h.date,
//              c.company_name, c.contact_name, c.email, c.sent_at, c.status,c.response,c.responded_at, c.template_used
//       FROM email_history h
//       LEFT JOIN email_history_companies c ON h.id = c.history_id
//       WHERE h.id = ?
//       ORDER BY h.date DESC
//     `, [id]);

//     if (results.length === 0) {
//       return res.status(404).json({ error: 'Entry not found' });
//     }

//     const historyEntry = {
//       id: results[0].id,
//       product: results[0].product,
//       date: results[0].date,
//       companies: [],
//     };

//     results.forEach((row) => {
//       if (row.company_name) {
//         historyEntry.companies.push({
//           companyName: row.company_name,
//           contactName: row.contact_name,
//           email: row.email,
//           sentAt: row.sent_at,
//           response: row.response,
//           respondedAt: row.responded_at,
//           status: row.status,
//           templateUsed: row.template_used,
//         });
//       }
//     });

//     res.json(historyEntry);

//   } catch (err) {
//     console.error('GET /history/:id error:', err);
//     res.status(500).json({ error: err.message });
//   }
// });


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
        subject
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
        message: row.message
      };
    });

    res.json({
      id: results[0].id,
      product: results[0].product,
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
      WHERE from_email IS NOT NULL 
        AND message IS NOT NULL
        AND reply_date IS NOT NULL
      ORDER BY reply_date DESC
    `;

    const [results] = await pool.query(query);

    if (results.length === 0) {
      return res.status(404).json({ success: false, message: "No email replies found" });
    }

    const cleanedResults = results.map(reply => {
      let cleanedSubject = reply.subject || '';
      cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
      cleanedSubject = cleanedSubject.replace(/^Re:\s*/, '');

      let cleanedMessage = reply.message;

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

      return {
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
      };
    });

    res.json({ success: true, count: cleanedResults.length, data: cleanedResults });

  } catch (error) {
    console.error("Error fetching email replies:", error);
    res.status(500).json({ success: false, message: "Error fetching email replies", error: error.message });
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





app.get('/api/tracking/all', async (req, res) => {
  try {
    // 1. GET ALL SENT EMAILS
    const [sentEmails] = await pool.query(`
      SELECT 
        id,
        batch_id,
        company_name,
        country,
        contact_name,
        email,
        sent_at,
        status,
        response,
        responded_at,
        template_used,
        product_name,
        'sent' as type
      FROM email_history_companies
      WHERE from_email IS NULL OR from_email = ''
      ORDER BY sent_at DESC
    `);

    // 2. GET ALL REPLIED EMAILS (from email_history_companies)
    const [repliedEmails] = await pool.query(`
      SELECT 
        id,
        batch_id,
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
        response,
        responded_at,
        'replied' as type
      FROM email_history_companies
      WHERE from_email IS NOT NULL 
        AND from_email != ''
        AND message IS NOT NULL
        AND reply_date IS NOT NULL
      ORDER BY reply_date DESC
    `);

    // 3. GET INTERESTED RESPONSES
    const [interestedEmails] = await pool.query(`
      SELECT 
        id,
        batch_id,
        company_name,
        country,
        contact_name,
        email,
        response,
        responded_at,
        product_name,
        'interested' as type
      FROM email_history_companies
      WHERE response = 'interested'
      ORDER BY responded_at DESC
    `);

    // 4. GET NOT INTERESTED RESPONSES
    const [notInterestedEmails] = await pool.query(`
      SELECT 
        id,
        batch_id,
        company_name,
        country,
        contact_name,
        email,
        response,
        responded_at,
        product_name,
        'not_interested' as type
      FROM email_history_companies
      WHERE response = 'not_interested'
      ORDER BY responded_at DESC
    `);

    // 5. GET NOT CONTACTED COMPANIES
    const [notContacted] = await pool.query(`
      SELECT DISTINCT
        b.id,
        b.company_name,
        b.country,
        b.product,
        b.hsn_code,
        GROUP_CONCAT(DISTINCT be.email SEPARATOR ', ') as emails,
        GROUP_CONCAT(DISTINCT bc.contact_number SEPARATOR ', ') as contacts,
        'not_contacted' as type
      FROM buyers b
      LEFT JOIN buyer_emails be ON b.id = be.buyer_id
      LEFT JOIN buyer_contacts bc ON b.id = bc.buyer_id
      WHERE NOT EXISTS (
        SELECT 1 FROM email_history_companies ehc 
        WHERE ehc.email IN (SELECT email FROM buyer_emails WHERE buyer_id = b.id)
      )
      GROUP BY b.id
      ORDER BY b.company_name
    `);

    // Clean the messages for replied emails
    const cleanedRepliedEmails = repliedEmails.map(reply => {
      let cleanedSubject = reply.subject || '';
      cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
      cleanedSubject = cleanedSubject.replace(/^Re:\s*/, '');

      let cleanedMessage = reply.message || '';
      
      // Remove everything after "On [date] wrote:" pattern
      const onIndex = cleanedMessage.indexOf('\nOn ');
      if (onIndex !== -1) {
        cleanedMessage = cleanedMessage.substring(0, onIndex).trim();
      }
      
      // Remove "wrote:" and everything after
      const wroteIndex = cleanedMessage.indexOf('wrote:');
      if (wroteIndex !== -1) {
        cleanedMessage = cleanedMessage.substring(0, wroteIndex).trim();
      }
      
      // Remove email headers and quotes
      cleanedMessage = cleanedMessage
        .replace(/\\u003C/g, '<')
        .replace(/\\u003E/g, '>')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/https?:\/\/[^\s]+/g, '')
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        .trim();

      return {
        id: reply.id,
        batch_id: reply.batch_id,
        company_name: reply.company_name,
        country: reply.country,
        contact_name: reply.contact_name,
        email: reply.email,
        from_email: reply.from_email,
        to_email: reply.to_email,
        subject: cleanedSubject,
        message: cleanedMessage,
        product_name: reply.product_name,
        reply_date: reply.reply_date,
        response: reply.response,
        responded_at: reply.responded_at,
        type: reply.type
      };
    });

    res.json({
      success: true,
      data: {
        sent: sentEmails,
        replied: cleanedRepliedEmails,
        interested: interestedEmails,
        not_interested: notInterestedEmails,
        notContacted: notContacted
      },
      counts: {
        totalSent: sentEmails.length,
        totalReplied: cleanedRepliedEmails.length,
        totalInterested: interestedEmails.length,
        totalNotInterested: notInterestedEmails.length,
        totalNotContacted: notContacted.length
      }
    });

  } catch (err) {
    console.error('GET /api/tracking/all error:', err);
    res.status(500).json({ error: err.message });
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
      `SELECT id, email, response FROM email_history_companies 
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

    // ✅ Step 6: Do the update
    // ✅ Fixed — use batch_id consistently
const [updateResult] = await pool.query(
  `UPDATE email_history_companies
   SET response = ?, responded_at = NOW()
   WHERE batch_id = ? AND email = ?`,
  [response, batchId, email]
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
    // ✅ Step 8: Show exact DB error on screen
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