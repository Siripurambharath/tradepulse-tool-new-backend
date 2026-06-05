const Bull = require('bull');
const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const nodemailer = require('nodemailer');
const mysql = require('mysql2/promise');
require('dotenv').config();

/* ─────────────────────────────────────────────
   MYSQL POOL
───────────────────────────────────────────── */

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: "seller_buyer_dummy",
  // database: "buyer-seller",
  waitForConnections: true,
  connectionLimit: 20,
});

/* ─────────────────────────────────────────────
   BULL QUEUE
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

/* ─────────────────────────────────────────────
   BULL BOARD
───────────────────────────────────────────── */

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({ queues: [new BullAdapter(emailQueue)], serverAdapter });

/* ─────────────────────────────────────────────
   NODEMAILER
───────────────────────────────────────────── */

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: { rejectUnauthorized: false },
});

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */

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

async function dbCreateHistoryBatch(batchId, product, date) {
  await pool.query(
    'INSERT IGNORE INTO email_history (id, product, date) VALUES (?, ?, ?)',
    [batchId, product, date]
  );
}

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

/* ─────────────────────────────────────────────
   WORKER
───────────────────────────────────────────── */

emailQueue.process(async (job) => {
  const {
    recipientEmail,
    subject,
    message,
    product,
    company,
    batchId,
    batchProduct,
    batchDate,
    isFirst,
  } = job.data;

  if (isFirst) {
    await dbCreateHistoryBatch(batchId, batchProduct, batchDate);
  }
  await job.progress(20);

  try {
    const info = await transporter.sendMail({
      from: `"Trade Platform" <${process.env.EMAIL_USER}>`,
      to: recipientEmail,
      subject: subject || `Business Opportunity - ${product}`,
      html: buildHtml(message, product),
    });
    console.log(`Sent to ${recipientEmail} [${info.messageId}]`);
    await job.progress(70);

    await dbInsertCompanyRow(batchId, company, 'Sent');
    await job.progress(100);

    return { recipientEmail, status: 'Sent', messageId: info.messageId };
  } catch (sendErr) {
    console.error(`Failed to send to ${recipientEmail}:`, sendErr.message);
    await job.progress(70);
    await dbInsertCompanyRow(batchId, company, 'Failed');
    await job.progress(100);
    throw sendErr;
  }
});

emailQueue.on('completed', (job, result) => {
  console.log(`Job ${job.id} completed — ${result.recipientEmail} [${result.status}]`);
});
emailQueue.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed — ${job.data.recipientEmail}: ${err.message}`);
});

module.exports = { emailQueue, serverAdapter, pool };