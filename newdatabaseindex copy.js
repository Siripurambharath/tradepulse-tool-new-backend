const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const nodemailer = require('nodemailer');
const Bull = require('bull');
const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');
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
  // Rate limiter: max 20 emails per minute — safe for Gmail
  // Switch to max:100 when using SendGrid / Resend
  limiter: {
    max: 20,
    duration: 60000,
  },
});

// ─── Bull Board at /admin/queues ──────────────────────────────────────────────
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({ queues: [new BullAdapter(emailQueue)], serverAdapter });
app.use('/admin/queues', serverAdapter.getRouter());

// ─── Nodemailer transport (created once, reused across all jobs) ──────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: { rejectUnauthorized: false },
});

// ─── Helper: build HTML email ─────────────────────────────────────────────────
function buildHtml(message, product) {
  return `
    <!DOCTYPE html><html><head><style>
      body{font-family:Arial,sans-serif;line-height:1.6;color:#333}
      .container{max-width:600px;margin:0 auto;padding:20px}
      .header{background-color:#4F46E5;color:white;padding:20px;text-align:center}
      .content{padding:20px;background-color:#f9fafb}
      .footer{padding:20px;text-align:center;font-size:12px;color:#6b7280}
      .product{font-weight:bold;color:#4F46E5}
    </style></head><body>
      <div class="container">
        <div class="header"><h2>Business Opportunity</h2></div>
        <div class="content">
          ${message.replace(/\n/g, '<br/>')}
          <br/><br/>
          <p>Product/Service: <span class="product">${product}</span></p>
          <p>Best regards,<br/>Trade Platform Team</p>
        </div>
        <div class="footer">
          <p>This is an automated message from Trade Platform.</p>
        </div>
      </div>
    </body></html>
  `;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

// Creates the parent email_history row once per batch.
// INSERT IGNORE means if two jobs race to create it, only one wins — no error.
async function dbCreateHistoryBatch(batchId, product, date) {
  await pool.query(
    'INSERT IGNORE INTO email_history (id, product, date) VALUES (?, ?, ?)',
    [batchId, product, date]
  );
}

// Inserts one company row into email_history_companies
async function dbInsertCompanyRow(batchId, company, status) {
  await pool.query(
    `INSERT INTO email_history_companies
      (history_id, company_name, contact_name, email, sent_at, status, template_used)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      batchId,
      company.companyName,
      company.contactName,
      company.email,
      new Date(),
      status,
      company.templateUsed,
    ]
  );
}

// ─── Worker — ONE job = ONE recipient ─────────────────────────────────────────
emailQueue.process(async (job) => {
  const {
    recipientEmail,
    subject,
    message,
    product,
    company,        // { companyName, contactName, email, templateUsed }
    batchId,
    batchProduct,
    batchDate,
    isFirst,        // only job #0 creates the parent history row
  } = job.data;

  // Step 1 — create parent history row (first job only)
  if (isFirst) {
    await dbCreateHistoryBatch(batchId, batchProduct, batchDate);
  }
  await job.progress(20);

  const trackedSubject = `${subject || `Business Opportunity - ${product}`} [BATCH:${batchId}]`;

  try {
    // Step 2 — send the email
    const info = await transporter.sendMail({
      from: `"Trade Platform" <${process.env.EMAIL_USER}>`,
      to: recipientEmail,
      subject: trackedSubject,
      html: buildHtml(message, product),
      headers: {
        'X-Batch-ID': batchId,
        'X-Product': product,
        'Message-ID': `<${batchId}-${Date.now()}@yourdomain.com>`,
      },
    });

    console.log(`Sent to ${recipientEmail} [${info.messageId}]`);
    await job.progress(70);

    // Step 3 — save as 'Sent' ONCE after confirmed delivery
    await dbInsertCompanyRow(batchId, company, 'Sent');
    await job.progress(100);

    return { recipientEmail, status: 'Sent', messageId: info.messageId };

  } catch (sendErr) {
    // Save as 'Failed' then re-throw so Bull marks this job failed and retries
    console.error(`Failed to send to ${recipientEmail}:`, sendErr.message);
    await job.progress(70);
    await dbInsertCompanyRow(batchId, company, 'Failed');
    await job.progress(100);
    throw sendErr; // Bull will retry up to `attempts` times
  }
});

emailQueue.on('completed', (job, result) => {
  console.log(`Job ${job.id} completed — ${result.recipientEmail} [${result.status}]`);
});
emailQueue.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed — ${job.data.recipientEmail}: ${err.message}`);
});

/* ─────────────────────────────────────────────
   GET BUYERS
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
   SEND EMAIL (ENQUEUE JOBS)
───────────────────────────────────────────── */

app.post('/send-email', async (req, res) => {
  const { product, subject, message, historyPayload } = req.body;
  console.log('Received /send-email request with payload:', req.body);

  if (!historyPayload) {
    return res.status(400).json({ error: 'historyPayload is required' });
  }

  const { id: batchId, date: batchDate, companies } = historyPayload;

  if (!companies || companies.length === 0) {
    return res.status(400).json({ error: 'No recipients specified' });
  }

  try {
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
            batchProduct: product,
            batchDate,
            isFirst: index === 0,
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
   EMAIL HISTORY
───────────────────────────────────────────── */

app.get('/history', async (req, res) => {
  try {
    const [results] = await pool.query(`
      SELECT h.id, h.product, h.date,
             c.company_name, c.contact_name, c.email, c.sent_at, c.status, c.template_used
      FROM email_history h
      LEFT JOIN email_history_companies c ON h.id = c.history_id
      ORDER BY h.date DESC
    `);

    const historyMap = {};
    results.forEach((row) => {
      if (!historyMap[row.id]) {
        historyMap[row.id] = { id: row.id, product: row.product, date: row.date, companies: [] };
      }
      if (row.company_name) {
        historyMap[row.id].companies.push({
          companyName: row.company_name,
          contactName: row.contact_name,
          email: row.email,
          sentAt: row.sent_at,
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

app.get('/history/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [results] = await pool.query(`
      SELECT h.id, h.product, h.date,
             c.company_name, c.contact_name, c.email, c.sent_at, c.status, c.template_used
      FROM email_history h
      LEFT JOIN email_history_companies c ON h.id = c.history_id
      WHERE h.id = ?
      ORDER BY h.date DESC
    `, [id]);

    if (results.length === 0) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    const historyEntry = {
      id: results[0].id,
      product: results[0].product,
      date: results[0].date,
      companies: [],
    };

    results.forEach((row) => {
      if (row.company_name) {
        historyEntry.companies.push({
          companyName: row.company_name,
          contactName: row.contact_name,
          email: row.email,
          sentAt: row.sent_at,
          status: row.status,
          templateUsed: row.template_used,
        });
      }
    });

    res.json(historyEntry);

  } catch (err) {
    console.error('GET /history/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────
   GET REPLIES FOR A HISTORY ENTRY
───────────────────────────────────────────── */

// Returns all replies received for a given batch/history id
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

/* ─────────────────────────────────────────────
   EMAIL TEMPLATES
───────────────────────────────────────────── */

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
      SELECT DISTINCT
        er.id,
        er.batch_id,
        er.history_id,
        er.from_email,
        er.to_email,
        er.subject,
        er.message,
        er.product_name,
        er.reply_date,
        ehc.company_name,
        ehc.contact_name,
        ehc.status,
        ehc.template_used,
        be.buyer_id,
        bc.contact_number
      FROM email_replies er
      LEFT JOIN email_history_companies ehc ON ehc.history_id = er.history_id
      LEFT JOIN buyer_emails be ON be.email = er.to_email
      LEFT JOIN buyer_contacts bc ON bc.buyer_id = be.buyer_id
      ORDER BY er.reply_date DESC
    `;
    
    const [results] = await pool.query(query);
    
    if (results.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No email replies found"
      });
    }
    
    // Remove duplicates by id (keep first occurrence)
    const uniqueResults = [];
    const seenIds = new Set();
    
    for (const reply of results) {
      if (!seenIds.has(reply.id)) {
        seenIds.add(reply.id);
        uniqueResults.push(reply);
      }
    }
    
    // Clean each unique reply
    const cleanedResults = uniqueResults.map(reply => {
      // Clean the subject - remove batch ID and extra text
     let cleanedSubject = reply.subject || '';  // ✅ Handle null
      cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
      cleanedSubject = cleanedSubject.replace(/^Re:\s*/, '');
      
      // Clean the message - extract only the reply content
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
        history_id: reply.history_id,
        from_email: reply.from_email,
        to_email: reply.to_email,
        subject: cleanedSubject,
        message: cleanedMessage,
        product_name: reply.product_name,
        reply_date: reply.reply_date,
        company_name: reply.company_name,
        contact_name: reply.contact_name,
        status: reply.status,
        template_used: reply.template_used,
        buyer_id: reply.buyer_id,
        contact_number: reply.contact_number
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




app.get('/api/replyhistory/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const query = `
      SELECT 
        er.id,
        er.batch_id,
        er.history_id,
        er.from_email,
        er.to_email,
        er.subject,
        er.message,
        er.product_name,
        er.reply_date,
        ehc.company_name,
        ehc.contact_name,
        ehc.status,
        ehc.template_used,
        be.buyer_id,
        bc.contact_number
      FROM email_replies er
      LEFT JOIN email_history_companies ehc ON ehc.history_id = er.history_id
      LEFT JOIN buyer_emails be ON be.email = er.to_email
      LEFT JOIN buyer_contacts bc ON bc.buyer_id = be.buyer_id
      WHERE er.id = ?
      LIMIT 1
    `;
    
    const [results] = await pool.query(query, [id]);
    
    if (results.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Email reply not found"
      });
    }
    
    // Clean subject and message
    let cleanedSubject = results[0].subject;
    cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
    cleanedSubject = cleanedSubject.replace(/^Re:\s*/, '');
    
    let cleanedMessage = results[0].message;
    const onIndex = cleanedMessage.indexOf('\nOn');
    if (onIndex !== -1) {
      cleanedMessage = cleanedMessage.substring(0, onIndex).trim();
    }
    
    cleanedMessage = cleanedMessage
      .replace(/\\u003C/g, '<')
      .replace(/\\u003E/g, '>')
      .trim();
    
    const response = {
      id: results[0].id,
      batch_id: results[0].batch_id,
      history_id: results[0].history_id,
      from_email: results[0].from_email,
      to_email: results[0].to_email,
      subject: cleanedSubject,
      message: cleanedMessage,
      product_name: results[0].product_name,
      reply_date: results[0].reply_date,
      company_name: results[0].company_name,
      contact_name: results[0].contact_name,
      status: results[0].status,
      template_used: results[0].template_used,
      buyer_id: results[0].buyer_id,
      contact_number: results[0].contact_number
    };
    
    res.json({
      success: true,
      data: response
    });
    
  } catch (error) {
    console.error("Error fetching email reply:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching email reply",
      error: error.message
    });
  }
});/* ─────────────────────────────────────────────
   START SERVER
───────────────────────────────────────────── */

app.listen(5000, () => {
  console.log(`Server running on port 5000`);
  console.log(`Bull Board → http://localhost:5000/admin/queues`);
});