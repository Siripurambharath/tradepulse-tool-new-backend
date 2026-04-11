const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const nodemailer = require('nodemailer');
const Bull = require('bull');
const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ─── DB connection ────────────────────────────────────────────────────────────
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

db.connect((err) => {
  if (err) console.error('Database connection failed:', err);
  else console.log('Connected to MySQL database');
});

// ─── Bull Email Queue — one job per recipient ─────────────────────────────────
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
function dbCreateHistoryBatch(batchId, product, date) {
  return new Promise((resolve, reject) => {
    db.query(
      'INSERT IGNORE INTO email_history (id, product, date) VALUES (?, ?, ?)',
      [batchId, product, date],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

// Inserts one row per recipient — only called after the email actually sends.
function dbInsertCompanyRow(batchId, company, status) {
  return new Promise((resolve, reject) => {
    db.query(
      `INSERT INTO email_history_companies
         (history_id, company_name, contact_name, email, sent_at, status, template_used)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        batchId,
        company.companyName,
        company.contactName,
        company.email,
        new Date().toISOString(),
        status,               // 'Sent' or 'Failed'
        company.templateUsed,
      ],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

// ─── Worker — ONE job = ONE recipient ─────────────────────────────────────────
emailQueue.process(async (job) => {
  const {
    recipientEmail,   // single email address for this job
    subject,
    message,
    product,
    company,          // { companyName, contactName, email, templateUsed }
    batchId,          // shared ID across all jobs in this send action
    batchProduct,
    batchDate,
    isFirst,          // only job #0 creates the parent history row
  } = job.data;

  // Step 1 — create parent history row (first job only)
  if (isFirst) {
    await dbCreateHistoryBatch(batchId, batchProduct, batchDate);
  }
  await job.progress(20);

  // Step 2 — send email to this single recipient
  try {
    const info = await transporter.sendMail({
      from: `"Trade Platform" <${process.env.EMAIL_USER}>`,
      to: recipientEmail,
      subject: subject || `Business Opportunity - ${product}`,
      html: buildHtml(message, product),
    });
    console.log(`Sent to ${recipientEmail} [${info.messageId}]`);
    await job.progress(70);

    // Step 3 — save as 'Sent' only after confirmed delivery
    await dbInsertCompanyRow(batchId, company, 'Sent');
    await job.progress(100);

    return { recipientEmail, status: 'Sent', messageId: info.messageId };

  } catch (sendErr) {
    // Save as 'Failed' then re-throw so Bull marks this job failed and retries
    console.error(`Failed to send to ${recipientEmail}:`, sendErr.message);
    await job.progress(70);
    await dbInsertCompanyRow(batchId, company, 'Failed');
    await job.progress(100);
    throw sendErr;  // Bull will retry up to `attempts` times
  }
});

emailQueue.on('completed', (job, result) => {
  console.log(`Job ${job.id} completed — ${result.recipientEmail} [${result.status}]`);
});
emailQueue.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed — ${job.data.recipientEmail}: ${err.message}`);
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/companies', (req, res) => {
  db.query('SELECT * FROM companies', (err, result) => {
    if (err) return res.status(500).json({ error: 'Database query failed' });
    res.json(result);
  });
});

// POST /send-email
// Enqueues ONE Bull job per recipient.
// Returns { batchId, jobIds[], total }
app.post('/send-email', async (req, res) => {
  const { product, subject, message, historyPayload } = req.body;
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
            company,           // full company object stored in the job
            batchId,
            batchProduct: product,
            batchDate,
            isFirst: index === 0,
          },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 3000 },
            removeOnComplete: false,  // keep visible in Bull Board after done
            removeOnFail: false,      // keep visible for retry from Bull Board
            jobId: `${batchId}-${index}`,  // readable ID in Bull Board
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

// GET /batch-status/:batchId?jobIds=id1,id2,id3,...
// Frontend polls this every 2s with the full jobIds list.
// Returns per-job breakdown + summary counts.
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
          state,                                              // waiting|active|completed|failed
          progress: job._progress || 0,
          result: state === 'completed' ? job.returnvalue : null,
          reason: state === 'failed' ? job.failedReason : null,
        };
      })
    );

    const total     = jobStatuses.length;
    const completed = jobStatuses.filter((j) => j.state === 'completed').length;
    const failed    = jobStatuses.filter((j) => j.state === 'failed').length;
    const active    = jobStatuses.filter((j) => j.state === 'active').length;
    const waiting   = jobStatuses.filter((j) => ['waiting', 'delayed'].includes(j.state)).length;

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

// GET /history
app.get('/history', (req, res) => {
  const query = `
    SELECT h.id, h.product, h.date,
           c.company_name, c.contact_name, c.email, c.sent_at, c.status, c.template_used
    FROM email_history h
    LEFT JOIN email_history_companies c ON h.id = c.history_id
    ORDER BY h.date DESC
  `;
  db.query(query, (err, results) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch history' });

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
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Bull Board → http://localhost:${PORT}/admin/queues`);
});