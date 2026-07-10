// routes/historyRoutes.js
const express = require('express');
const router = express.Router();

// GET /history - Get all history batches for a seller
router.get('/history', async (req, res) => {
  const pool = req.app.get('pool');
  const { seller_id } = req.query;
  console.log('GET /history called with seller_id:', seller_id);
  
  if (!seller_id) {
    return res.status(400).json({ error: 'seller_id is required' });
  }

  try {
    const [batches] = await pool.query(`
      SELECT DISTINCT
        batch_id,
        MAX(product_name) as product_name,
        MAX(sent_at) as sent_at,
        MAX(multiple_products) as multiple_products,
        MAX(CASE WHEN template_used IS NOT NULL THEN template_used END) as template_used
      FROM email_history_companies
      WHERE seller_id = ?
      GROUP BY batch_id
      ORDER BY MAX(sent_at) DESC
    `, [seller_id]);

    // For each batch, get its companies data
    const historyData = await Promise.all(
      batches.map(async (batch) => {
        const [results] = await pool.query(
          `
          SELECT
            batch_id AS id,
            product_name AS product,
            company_name,
            contact_name,
            email,
            sent_at,
            status,
            response,
            responded_at,
            template_used,
            message,
            reply_date,
            subject
          FROM email_history_companies
          WHERE batch_id = ? AND seller_id = ?
          ORDER BY sent_at DESC
          `,
          [batch.batch_id, seller_id]
        );

        if (!results.length) return null;

        // Fix counts logic
        const counts = {
          total: results.length,
          replied: results.filter(row => row.message && row.message.trim() !== '').length,
          interested: results.filter(row => row.response === 'interested').length,
          notInterested: results.filter(row => row.response === 'not_interested').length,
          emailSent: results.filter(row => row.status === 'sent' || row.response === null).length
        };

        // FILTER: Remove entries that have ANY non-interested responses along with interested responses
        // This means: if there's at least one interested AND (any not_interested OR any null response OR any email sent)
        const hasNonInterested = results.some(row => 
          row.response === 'not_interested' || 
          row.response === null || 
          row.status === 'sent'
        );
        
        if (counts.interested > 0 && hasNonInterested) {
          return null; // Remove this batch
        }

        const companies = results.map((row) => {
          let displayStatus = 'Email Sent';
          
          if (row.response === 'interested') {
            displayStatus = 'Interested';
          } else if (row.response === 'not_interested') {
            displayStatus = 'Not Interested';
          } else if (row.message && row.message.trim() !== '') {
            displayStatus = 'Replied';
          }

          return {
            companyName: row.company_name,
            contactName: row.contact_name,
            email: row.email,
            sentAt: row.sent_at,
            response: row.response,
            respondedAt: row.reply_date || row.responded_at,
            status: displayStatus,
            templateUsed: row.template_used,
            subject: row.subject,
            message: row.message,
            product: row.product
          };
        });

        // Determine main product display
        let mainProduct = results[0]?.product || batch.product_name;
        if (batch.multiple_products === 1) {
          mainProduct = "General Products";
        }

        return {
          id: batch.batch_id,
          product: mainProduct,
          multiple_products: batch.multiple_products,
          date: batch.sent_at,
          companies,
          counts
        };
      })
    );

    // Filter out any null results
    const filteredData = historyData.filter(item => item !== null);
    
    // Remove duplicates by batch_id
    const uniqueData = filteredData.reduce((acc, current) => {
      const existing = acc.find(item => item.id === current.id);
      if (!existing) {
        acc.push(current);
      }
      return acc;
    }, []);

    res.json(uniqueData);

  } catch (err) {
    console.error('GET /history error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /history/:id - Get single history batch by ID
router.get('/history/:id', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const { id } = req.params;

    const [results] = await pool.query(
      `
      SELECT
        batch_id AS id,
        product_name AS product,
        company_name,
        contact_name,
        email,
        sent_at,
        status,
        response,
        responded_at,
        template_used,
        message,
        reply_date,
        subject,
        multiple_products
      FROM email_history_companies
      WHERE batch_id = ?
      ORDER BY sent_at DESC
      `,
      [id]
    );

    if (!results.length) {
      return res.status(404).json({
        success: false,
        message: 'History not found'
      });
    }

    const counts = {
      total: results.length,
      replied: 0,
      interested: 0,
      notInterested: 0,
      emailSent: 0
    };

    // If any row in the batch contains a message
    counts.replied = results.some(
      row => row.message && row.message.trim() !== ''
    ) ? 1 : 0;

    results.forEach((row) => {
      if (row.response === 'interested') {
        counts.interested++;
      }

      if (row.response === 'not_interested') {
        counts.notInterested++;
      }

      if (row.status === 'sent') {
        counts.emailSent++;
      }
    });

    const companies = results.map((row) => {
      let displayStatus = 'Email Sent';

      if (row.message && row.message.trim() !== '') {
        displayStatus = 'Replied';
      } else if (row.response === 'interested') {
        displayStatus = 'Interested';
      } else if (row.response === 'not_interested') {
        displayStatus = 'Not Interested';
      }

      // Clean the message - take only the first line before any newline
      let cleanedMessage = row.message;
      let cleanedSubject = row.subject;
      
      if (row.message && row.message.trim() !== '') {
        // Get the first line only (before first newline)
        const firstLine = row.message.split('\n')[0];
        cleanedMessage = firstLine.trim();
      }

      return {
        companyName: row.company_name,
        contactName: row.contact_name,
        email: row.email,
        sentAt: row.sent_at,
        response: row.response,
        respondedAt: row.reply_date || row.responded_at,
        status: displayStatus,
        templateUsed: row.template_used,
        subject: cleanedSubject,
        message: cleanedMessage,
        product: row.product
      };
    });

    // Get multiple_products value from first row (same for all in batch)
    const multipleProducts = results[0].multiple_products;

    // Determine main product display
    let mainProduct = results[0].product;
    if (multipleProducts === 1) {
      mainProduct = "General Products";
    }

    res.json({
      id: results[0].id,
      product: mainProduct,
      multiple_products: multipleProducts,
      date: results[0].sent_at,
      companies,
      counts
    });

  } catch (err) {
    console.error('GET /history/:id error:', err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

// GET /history/:id/replies - Get replies for a specific history batch
router.get('/history/:id/replies', async (req, res) => {
  const pool = req.app.get('pool');
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

module.exports = router;