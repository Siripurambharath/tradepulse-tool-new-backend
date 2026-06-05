const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const { MeiliSearch } = require('meilisearch');

const app = express();
app.use(cors());
app.use(express.json());

// ─── MySQL Pool ───────────────────────────────────────────────
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: "seller_buyer_dummy",
  // database: "buyer-seller",
  waitForConnections: true,
  connectionLimit: 10,
});

// ─── MeiliSearch Client ───────────────────────────────────────
const meili = new MeiliSearch({
  host: 'http://localhost:7700',
  apiKey: 'masterKey', // change to your master key
});

const INDEX_NAME = 'shipments';

// ─── Cursor Helpers ───────────────────────────────────────────
const encodeCursor = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const decodeCursor = (cursor) => {
  try { return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')); }
  catch { return null; }
};

// ─── SETUP: Index MeiliSearch ─────────────────────────────────
// Run once via GET /admin/index-meili
app.get('/admin/index-meili', async (req, res) => {
  try {
    const index = meili.index(INDEX_NAME);

    // Configure searchable + filterable fields
    await index.updateSettings({
      searchableAttributes: [
        'exporter_name',
        'product_description',
        'hsncode',
        'importer_buyer_name',
        'country_of_discharge',
        'port_of_loading',
        'port_of_discharge',
      ],
      filterableAttributes: ['country_of_discharge', 'mode_shipment', 'year', 'month'],
      sortableAttributes: ['id', 'total_fob_value', 'dateadded'],
    });

    // Batch-load from MySQL
    let offset = 0;
    const batchSize = 1000;
    let total = 0;

    while (true) {
      const [rows] = await pool.execute(
        `SELECT * FROM tbl_shipmentdata LIMIT ? OFFSET ?`,
        [batchSize, offset]
      );
      if (rows.length === 0) break;

      await index.addDocuments(rows, { primaryKey: 'id' });
      total += rows.length;
      offset += batchSize;
    }

    res.json({ success: true, indexed: total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API 1: COUNT ─────────────────────────────────────────────
// GET /companies/count?search=cotton&country=AUSTRALIA
app.get('/companies/count', async (req, res) => {
  try {
    const { search, country, mode_shipment, year } = req.query;

    if (search) {
      // Use MeiliSearch for fast count with search
      const index = meili.index(INDEX_NAME);
      const filters = buildMeiliFilters({ country, mode_shipment, year });
      const result = await index.search(search, {
        limit: 0,
        filter: filters || undefined,
      });
      return res.json({ count: result.estimatedTotalHits });
    }

    // Pure MySQL count (no text search)
    let query = `SELECT COUNT(*) as count FROM tbl_shipmentdata WHERE 1=1`;
    const params = [];
    if (country) { query += ` AND country_of_discharge = ?`; params.push(country); }
    if (mode_shipment) { query += ` AND mode_shipment = ?`; params.push(mode_shipment); }
    if (year) { query += ` AND year = ?`; params.push(year); }

    const [[row]] = await pool.execute(query, params);
    res.json({ count: row.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API 2: SEARCH (MeiliSearch-powered) ─────────────────────
// GET /companies/search?q=cotton&limit=20&page=0
app.get('/companies/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const page = parseInt(req.query.page) || 0;
    const { country, mode_shipment, year } = req.query;

    const index = meili.index(INDEX_NAME);
    const filters = buildMeiliFilters({ country, mode_shipment, year });

    const result = await index.search(q, {
      limit,
      offset: page * limit,
      filter: filters || undefined,
      attributesToRetrieve: ['*'],
    });

    res.json({
      data: result.hits,
      total: result.estimatedTotalHits,
      page,
      limit,
      hasMore: (page + 1) * limit < result.estimatedTotalHits,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API 3: LIST (MySQL cursor pagination, no search) ─────────
// GET /companies?cursor=xxx&limit=50
app.get('/companies', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const cursorData = req.query.cursor ? decodeCursor(req.query.cursor) : null;
    const { country, mode_shipment, year } = req.query;

    let query = `SELECT * FROM tbl_shipmentdata WHERE 1=1`;
    const params = [];

    if (country) { query += ` AND country_of_discharge = ?`; params.push(country); }
    if (mode_shipment) { query += ` AND mode_shipment = ?`; params.push(mode_shipment); }
    if (year) { query += ` AND year = ?`; params.push(year); }
    if (cursorData?.id) { query += ` AND id > ?`; params.push(cursorData.id); }

    query += ` ORDER BY id ASC LIMIT ?`;
    params.push(limit + 1);

    const [rows] = await pool.execute(query, params);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    const nextCursor = hasMore && rows.length > 0
      ? encodeCursor({ id: rows[rows.length - 1].id })
      : null;

    res.json({ data: rows, next_cursor: nextCursor, has_more: hasMore });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API 4: SINGLE COMPANY ────────────────────────────────────
app.get('/companies/:id', async (req, res) => {
  try {
    const [[row]] = await pool.execute(
      `SELECT * FROM tbl_shipmentdata WHERE id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────
function buildMeiliFilters({ country, mode_shipment, year }) {
  const parts = [];
  if (country) parts.push(`country_of_discharge = "${country}"`);
  if (mode_shipment) parts.push(`mode_shipment = "${mode_shipment}"`);
  if (year) parts.push(`year = "${year}"`);
  return parts.length ? parts.join(' AND ') : null;
}



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


app.listen(5000, () => console.log('Server: http://localhost:5000'));