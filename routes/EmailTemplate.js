const express = require('express');
const router = express.Router();
const { pool } = require('./../Queues');

/* ─────────────────────────────────────────────
   CREATE TEMPLATE
───────────────────────────────────────────── */

router.post('/', async (req, res) => {
  try {
    const { name, subject, body } = req.body;

    if (!name || !subject || !body) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    const [result] = await pool.query(
      `INSERT INTO email_templates (name, subject, body) VALUES (?, ?, ?)`,
      [name, subject, body]
    );

    res.json({ success: true, message: 'Template created successfully', insertId: result.insertId });
  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ─────────────────────────────────────────────
   GET ALL TEMPLATES
───────────────────────────────────────────── */

router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM email_templates ORDER BY id DESC`);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ─────────────────────────────────────────────
   DELETE TEMPLATE
───────────────────────────────────────────── */

router.delete('/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM email_templates WHERE id = ?`, [req.params.id]);
    res.json({ success: true, message: 'Template deleted successfully' });
  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;