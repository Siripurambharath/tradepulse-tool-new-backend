// routes/searchRoutes.js
const express = require('express');
const router = express.Router();

module.exports = (pool) => {
  // Store response endpoint
  router.post('/api/store-response', async (req, res) => {
    const { 
      email, 
      response, 
      companyName, 
      country, 
      contactName, 
      productName,
      templateUsed,
      buyer_id,
      seller_id
    } = req.body;

    // Validation
    if (!email || !response || !['interested', 'not_interested'].includes(response)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email and valid response (interested/not_interested) are required' 
      });
    }

    try {
      const batchId = generateUUID();
      const yourEmail = process.env.EMAIL_USER;
      
      // Get seller_id from request or fallback to null
      const sellerId = seller_id || null;
      
      const [result] = await pool.query(
        `INSERT INTO email_history_companies 
          (batch_id, buyer_id, seller_id, company_name, country, contact_name, email, 
           response, responded_at, product_name, template_used, status,
           from_email, to_email)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, 'responded', ?, ?)`,
        [
          batchId,
          buyer_id || null,
          sellerId,
          companyName || null,
          country || null,
          contactName || null,
          email,
          response,
          productName || null,
          templateUsed || 'Manual Response',
          email,        
          yourEmail     
        ]
      );

      console.log('✅ New response stored:', {
        id: result.insertId,
        batchId,
        seller_id: sellerId,
        buyer_id: buyer_id,
        email,
        response,
        from_email: email,
        to_email: yourEmail,
        timestamp: new Date().toISOString()
      });

      res.status(200).json({
        success: true,
        message: `${response === 'interested' ? 'Interested' : 'Not Interested'} response recorded successfully`,
        data: {
          id: result.insertId,
          batchId: batchId,
          seller_id: sellerId,
          buyer_id: buyer_id,
          email: email,
          response: response,
          from_email: email,
          to_email: yourEmail,
          respondedAt: new Date().toISOString()
        }
      });

    } catch (error) {
      console.error('Error storing response:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  });

  // Get buyer countries filter
  router.get("/filters/buyer-countries", async (req, res) => {
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

  // Get products filter
  router.get("/filters/products", async (req, res) => {
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

  // Get buyer by ID
  router.get("/buyers/:id", async (req, res) => {
    try {
      const { id } = req.params;

      const sql = `
        SELECT
          b.*,
          GROUP_CONCAT(DISTINCT bc.contact_number SEPARATOR ', ') AS contacts,
          GROUP_CONCAT(DISTINCT be.email SEPARATOR ', ') AS emails
        FROM buyers b
        LEFT JOIN buyer_contacts bc ON b.id = bc.buyer_id
        LEFT JOIN buyer_emails be ON b.id = be.buyer_id
        WHERE b.id = ?
        GROUP BY b.id
      `;

      const [rows] = await pool.query(sql, [id]);

      if (rows.length === 0) {
        return res.status(404).json({ error: "Buyer not found" });
      }

      res.json({ data: rows[0] });
    } catch (err) {
      console.error("GET /buyers/:id ERROR:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Helper function to generate UUID
  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  return router;
};