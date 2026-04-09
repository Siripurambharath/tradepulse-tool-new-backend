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

// ─── DB connection ───────────────────────────────────────────────────────────
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
});

db.connect((err) => {
  if (err) {
    console.error('Database connection failed:', err);
  } else {
    console.log('Connected to MySQL database');
  }
});

// ─── Bull Email Queue ─────────────────────────────────────────────────────────
// Redis must be running locally on default port 6379
const emailQueue = new Bull('email-queue', {
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
  },
});

// ─── Bull Board dashboard at /admin/queues ────────────────────────────────────
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullAdapter(emailQueue)],
  serverAdapter,
});

app.use('/admin/queues', serverAdapter.getRouter());

// ─── Queue Processor (worker) ─────────────────────────────────────────────────
// This runs in the same process. For production, move to a separate worker file.
emailQueue.process(async (job) => {
  const { emails, product, subject, message, historyPayload } = job.data;

  // 1. Send the email
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; }
        .content { padding: 20px; background-color: #f9fafb; }
        .footer { padding: 20px; text-align: center; font-size: 12px; color: #6b7280; }
        .product { font-weight: bold; color: #4F46E5; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header"><h2>Business Opportunity</h2></div>
        <div class="content">
          ${message.replace(/\n/g, '<br/>')}
          <br/><br/>
          <p>Product/Service: <span class="product">${product}</span></p>
          <br/>
          <p>Best regards,<br/>Trade Platform Team</p>
        </div>
        <div class="footer">
          <p>This is an automated message from Trade Platform. Please reply to this email for any inquiries.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const mailOptions = {
    from: `"Trade Platform" <${process.env.EMAIL_USER}>`,
    to: emails.join(','),
    subject: subject || `Business Opportunity - ${product}`,
    html: htmlContent,
  };

  // Report progress: 50% = email sent
  await job.progress(50);
  const info = await transporter.sendMail(mailOptions);
  console.log('Email sent:', info.messageId);

  // 2. Save history to DB
  const { id, date, companies } = historyPayload;

  await new Promise((resolve, reject) => {
    db.query(
      'INSERT INTO email_history (id, product, date) VALUES (?, ?, ?)',
      [id, product, date],
      (err) => {
        if (err) return reject(err);

        const values = companies.map((c) => [
          id,
          c.companyName,
          c.contactName,
          c.email,
          c.sentAt,
          c.status,
          c.templateUsed,
        ]);

        db.query(
          `INSERT INTO email_history_companies
           (history_id, company_name, contact_name, email, sent_at, status, template_used)
           VALUES ?`,
          [values],
          (err2) => {
            if (err2) return reject(err2);
            resolve();
          }
        );
      }
    );
  });

  // Report progress: 100% = saved to DB
  await job.progress(100);

  return { messageId: info.messageId, recipientsCount: emails.length };
});

// Log queue events for debugging
emailQueue.on('completed', (job, result) => {
  console.log(`Job ${job.id} completed:`, result);
});
emailQueue.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed:`, err.message);
});

// ─── API Routes ───────────────────────────────────────────────────────────────

// Get companies
app.get('/companies', (req, res) => {
  db.query('SELECT * FROM companies', (err, result) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Database query failed' });
    }
    res.json(result);
  });
});

// Enqueue email job — returns jobId immediately
app.post('/send-email', async (req, res) => {
  const { emails, product, subject, message, historyPayload } = req.body;

  if (!emails || emails.length === 0) {
    return res.status(400).json({ error: 'No recipients specified' });
  }

  try {
    const job = await emailQueue.add(
      { emails, product, subject, message, historyPayload },
      {
        attempts: 3,              // retry up to 3 times on failure
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: false,  // keep in dashboard after completion
        removeOnFail: false,
      }
    );

    console.log(`Email job ${job.id} enqueued for ${emails.length} recipient(s)`);
    res.json({ jobId: job.id.toString() });
  } catch (err) {
    console.error('Queue error:', err);
    res.status(500).json({ error: 'Failed to enqueue email job', details: err.message });
  }
});

// Poll job status — frontend calls this every 2s
app.get('/job-status/:jobId', async (req, res) => {
  try {
    const job = await emailQueue.getJob(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const state = await job.getState();   // waiting | active | completed | failed | delayed
    const progress = job._progress || 0;
    const result = state === 'completed' ? job.returnvalue : null;
    const reason = state === 'failed' ? job.failedReason : null;

    res.json({ jobId: job.id, state, progress, result, reason });
  } catch (err) {
    console.error('Status check error:', err);
    res.status(500).json({ error: 'Failed to get job status' });
  }
});

// Get history
app.get('/history', (req, res) => {
  const query = `
    SELECT h.id, h.product, h.date,
           c.company_name, c.contact_name, c.email, c.sent_at, c.status, c.template_used
    FROM email_history h
    LEFT JOIN email_history_companies c ON h.id = c.history_id
    ORDER BY h.date DESC
  `;

  db.query(query, (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to fetch history' });
    }

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