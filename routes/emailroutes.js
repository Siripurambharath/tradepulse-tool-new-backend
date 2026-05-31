const express = require("express")
const router = express.Router();
const mysql = require("mysql2/promise");
require('dotenv').config();

router.post("/email-templates", async (req, res) => {
  try {
const express = require('express');
const router = express.Router();
const { emailQueue, pool } = require('./../Queues');

/* ─────────────────────────────────────────────
   SEND EMAIL (ENQUEUE JOBS)
───────────────────────────────────────────── */

router.post('/send-email', async (req, res) => {
  const { product, subject, message, historyPayload } = req.body;
  console.log('Received /send-email request:', req.body);

  if (!historyPayload) return res.status(400).json({ error: 'historyPayload is required' });

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

router.get('/batch-status/:batchId', async (req, res) => {
  const jobIdsParam = req.query.jobIds;
  if (!jobIdsParam) return res.status(400).json({ error: 'jobIds query param required' });

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

    const total     = jobStatuses.length;
    const completed = jobStatuses.filter((j) => j.state === 'completed').length;
    const failed    = jobStatuses.filter((j) => j.state === 'failed').length;
    const active    = jobStatuses.filter((j) => j.state === 'active').length;
    const waiting   = jobStatuses.filter((j) => ['waiting', 'delayed'].includes(j.state)).length;

    res.json({
      batchId: req.params.batchId,
      total, completed, failed, active, waiting,
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

router.get('/history', async (req, res) => {
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
          companyName:  row.company_name,
          contactName:  row.contact_name,
          email:        row.email,
          sentAt:       row.sent_at,
          status:       row.status,
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

module.exports = router;
    const { name, subject, body } = req.body;

    if (!name || !subject || !body) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    const [result] = await pool.query(
      `
      INSERT INTO email_templates
      (name, subject, body)
      VALUES (?, ?, ?)
      `,
      [name, subject, body]
    );

    res.json({
      success: true,
      message: "Template created successfully",
      insertId: result.insertId,
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      success: false,
      message: "Server error",
    });

  }
});

/*
=====================================
GET ALL TEMPLATES
=====================================
*/
router.get("/email-templates", async (req, res) => {
  try {

    const [rows] = await pool.query(`
      SELECT *
      FROM email_templates
      ORDER BY id DESC
    `);

    res.json({
      success: true,
      data: rows,
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      success: false,
      message: "Server error",
    });

  }
});

/*
=====================================
DELETE TEMPLATE
=====================================
*/
router.delete("/email-templates/:id", async (req, res) => {
  try {

    const { id } = req.params;

    await pool.query(
      `
      DELETE FROM email_templates
      WHERE id = ?
      `,
      [id]
    );

    res.json({
      success: true,
      message: "Template deleted successfully",
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      success: false,
      message: "Server error",
    });

  }
});

module.exports = router;
