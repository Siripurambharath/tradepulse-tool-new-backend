const express = require('express');
const router = express.Router();
const { pool } = require('./../Queues');

/* ─────────────────────────────────────────────
   GET COMPANIES
───────────────────────────────────────────── */

router.get('/', async (req, res) => {
  try {
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    const search = req.query.search || '';
    const country = req.query.country || '';
    const mode = req.query.mode_shipment || '';
    const year = req.query.year || '';

    let where = [];
    let values = [];

    if (search) {
      where.push(`(exporter_name LIKE ? OR product_description LIKE ? OR hsncode LIKE ?)`);
      values.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (country) { where.push(`country_of_discharge = ?`); values.push(country); }
    if (mode)    { where.push(`mode_shipment = ?`);        values.push(mode); }
    if (year)    { where.push(`year = ?`);                 values.push(year); }

    const whereQuery = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sql = `
      SELECT id, exporter_name, country_of_discharge, product_description,
             hsncode, mode_shipment, total_fob_value, fob_value_currency, email
      FROM valid_shipmentdata
      ${whereQuery}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await pool.query(sql, [...values, limit, offset]);
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM valid_shipmentdata ${whereQuery}`,
      values
    );

    res.json({ data: rows, total: countRows[0].total });
  } catch (err) {
    console.error('GET /companies error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────
   FILTERS
───────────────────────────────────────────── */

router.get('/filters/countries', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT DISTINCT country_of_discharge FROM valid_shipmentdata
      WHERE country_of_discharge IS NOT NULL ORDER BY country_of_discharge ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/filters/modes', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT DISTINCT mode_shipment FROM valid_shipmentdata
      WHERE mode_shipment IS NOT NULL ORDER BY mode_shipment ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/filters/years', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT DISTINCT year FROM valid_shipmentdata
      WHERE year IS NOT NULL ORDER BY year DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;