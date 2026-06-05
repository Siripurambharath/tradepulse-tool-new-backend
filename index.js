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
  // database: "buyer-seller",

  waitForConnections: true,
  connectionLimit: 20,
});


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
/* ─────────────────────────────────────────────
   GET COMPANIES
───────────────────────────────────────────── */

app.get("/companies", async (req, res) => {
  try {

    const limit = Number(req.query.limit || 50);

    const offset = Number(req.query.offset || 0);

    const search = req.query.search || "";

    const country = req.query.country || "";

    const mode = req.query.mode_shipment || "";

    const year = req.query.year || "";

    let where = [];

    let values = [];

    /* SEARCH */

    if (search) {

      where.push(`
        (
          exporter_name LIKE ?
          OR product_description LIKE ?
          OR hsncode LIKE ?
        )
      `);

      values.push(`%${search}%`);
      values.push(`%${search}%`);
      values.push(`%${search}%`);
    }

    /* FILTERS */

    if (country) {
      where.push(`country_of_discharge = ?`);
      values.push(country);
    }

    if (mode) {
      where.push(`mode_shipment = ?`);
      values.push(mode);
    }

    if (year) {
      where.push(`year = ?`);
      values.push(year);
    }

    const whereQuery =
      where.length > 0
        ? `WHERE ${where.join(" AND ")}`
        : "";

    /* MAIN QUERY */

    const sql = `
      SELECT
        id,
        exporter_name,
        country_of_discharge,
        product_description,
        hsncode,
        mode_shipment,
        total_fob_value,
        fob_value_currency, email

      FROM valid_shipmentdata

      ${whereQuery}

      ORDER BY id DESC

      LIMIT ?
      OFFSET ?
    `;

    const queryValues = [
      ...values,
      limit,
      offset
    ];

    const [rows] = await pool.query(
      sql,
      queryValues
    );

    /* COUNT */

    const countSql = `
      SELECT COUNT(*) as total
      FROM valid_shipmentdata
      ${whereQuery}
    `;

    const [countRows] =
      await pool.query(
        countSql,
        values
      );

    res.json({
      data: rows,
      total: countRows[0].total
    });

  } catch (err) {

    console.log(err);

    res.status(500).json({
      error: err.message
    });

  }
});

/* ─────────────────────────────────────────────
   COUNTRY FILTER
───────────────────────────────────────────── */

app.get("/filters/countries", async (req, res) => {
  try {

    const [rows] = await pool.query(`
      SELECT DISTINCT country_of_discharge
      FROM valid_shipmentdata
      WHERE country_of_discharge IS NOT NULL
      ORDER BY country_of_discharge ASC
    `);

    res.json(rows);

  } catch (err) {

    res.status(500).json({
      error: err.message
    });

  }
});

/* ─────────────────────────────────────────────
   MODE FILTER
───────────────────────────────────────────── */

app.get("/filters/modes", async (req, res) => {
  try {

    const [rows] = await pool.query(`
      SELECT DISTINCT mode_shipment
      FROM valid_shipmentdata
      WHERE mode_shipment IS NOT NULL
      ORDER BY mode_shipment ASC
    `);

    res.json(rows);

  } catch (err) {

    res.status(500).json({
      error: err.message
    });

  }
});

/* ─────────────────────────────────────────────
   YEAR FILTER
───────────────────────────────────────────── */

app.get("/filters/years", async (req, res) => {
  try {

    const [rows] = await pool.query(`
      SELECT DISTINCT year
      FROM valid_shipmentdata
      WHERE year IS NOT NULL
      ORDER BY year DESC
    `);

    res.json(rows);

  } catch (err) {

    res.status(500).json({
      error: err.message
    });

  }
});


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

/* ─────────────────────────────────────────────
   START SERVER
───────────────────────────────────────────── */

app.listen(5000, () => {
  console.log("Server running on port 5000");
});