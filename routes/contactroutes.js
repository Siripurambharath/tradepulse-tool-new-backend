// routes/contactRoutes.js
const express = require('express');
const router = express.Router();

// GET /api/contacts - Get all interested or replied contacts for a seller
router.get('/api/contacts', async (req, res) => {
  const pool = req.app.get('pool');
  const { seller_id } = req.query;

  console.log("Contact Details", req.query);

  if (!seller_id) {
    return res.status(400).json({ success: false, message: "seller_id is required" });
  }

  try {
    // Get only records that are either 'interested' OR have a reply (message is not null)
    const query = `
      SELECT 
        buyer_id,
        MAX(contact_name) as contact_name,
        MAX(from_email) as from_email,
        MAX(to_email) as to_email,
        MAX(company_name) as company_name,
        MAX(country) as country,
        MAX(product_name) as product_name,
        MAX(template_used) as template_used,
        COUNT(*) as interaction_count,
        MAX(CASE WHEN LOWER(status) = 'sent' THEN 1 ELSE 0 END) as has_sent,
        MAX(CASE WHEN LOWER(response) = 'interested' THEN 1 ELSE 0 END) as has_interested,
        MAX(COALESCE(reply_date, responded_at, sent_at)) as last_interaction
      FROM email_history_companies
      WHERE buyer_id IS NOT NULL
        AND seller_id = ?
        AND (
          LOWER(response) = 'interested' 
          OR (message IS NOT NULL AND message != '')
        )
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
    `;

    const [groupedResults] = await pool.query(query, [seller_id]);

    if (groupedResults.length === 0) {
      return res.status(404).json({ success: false, message: "No interested or replied contacts found" });
    }

    const cleanedResults = groupedResults.map(contact => {
      let cleanedProductName = contact.product_name || '';
      let cleanedTemplate = contact.template_used || '';
      
      const phoneNumber = contact.contact_name && contact.contact_name.match(/^\+?\d+$/) 
        ? contact.contact_name 
        : '';

      return {
        buyer_id: contact.buyer_id,
        contact_name: contact.contact_name || 'Unknown',
        from_email: contact.from_email || '',
        to_email: contact.to_email || '',
        company_name: contact.company_name || '',
        country: contact.country || '',
        product_name: cleanedProductName,
        template_used: cleanedTemplate,
        phone: phoneNumber,
        interaction_count: contact.interaction_count,
        status: contact.has_sent ? 'sent' : 'pending',
        response: contact.has_interested ? 'interested' : 'replied',
        last_interaction: contact.last_interaction
      };
    });

    res.json({ 
      success: true, 
      count: cleanedResults.length, 
      data: cleanedResults 
    });

  } catch (error) {
    console.error("Error fetching email replies:", error);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching email replies", 
      error: error.message 
    });
  }
});

// GET /api/replyhistory/:buyerId - Get detailed history for a specific buyer
router.get('/api/replyhistory/:buyerId', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const buyerId = req.params.buyerId;
    const sellerId = req.query.sellerId;

    // Validate sellerId
    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: "sellerId is required"
      });
    }

    const query = `
      SELECT 
        id,
        batch_id,
        buyer_id,
        seller_id,
        from_email,
        to_email,
        subject,
        message,
        product_name,
        reply_date,
        company_name,
        contact_name,
        country,
        status,
        template_used,
        response,
        responded_at,
        sent_at
      FROM email_history_companies
      WHERE buyer_id = ? AND seller_id = ?
      ORDER BY COALESCE(reply_date, responded_at, sent_at) DESC
    `;

    const [results] = await pool.query(query, [buyerId, sellerId]);

    if (results.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No replies found for this buyer and seller"
      });
    }

    // Clean the message and subject for each record
    const cleanedResults = results.map(reply => {
      let cleanedSubject = reply.subject || '';
      cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
      cleanedSubject = cleanedSubject.replace(/^Re:\s*/, '');

      let cleanedMessage = reply.message || '';

      if (reply.response !== 'interested') {
        const quotePatterns = [
          /\nOn\s+.+\s+wrote:\s*\n/i,
          /\n-----Original Message-----\s*\n/i,
          /\n>+\s*.+\n/i,
          /\n\n\n.*\nOn\s+/s
        ];

        let replyEndIndex = -1;
        for (const pattern of quotePatterns) {
          const match = cleanedMessage.match(pattern);
          if (match) {
            replyEndIndex = match.index;
            break;
          }
        }

        if (replyEndIndex !== -1) {
          cleanedMessage = cleanedMessage.substring(0, replyEndIndex).trim();
        } else {
          const parts = cleanedMessage.split(/\n\s*\n\s*\n/);
          if (parts.length > 0) {
            cleanedMessage = parts[0].trim();
          }
        }

        cleanedMessage = cleanedMessage
          .replace(/\\u003C/g, '<')
          .replace(/\\u003E/g, '>')
          .replace(/\[[^\]]*\]/g, '')
          .trim();
      }

      return {
        id: reply.id,
        batch_id: reply.batch_id,
        seller_id: reply.seller_id,
        buyer_id: reply.buyer_id,
        from_email: reply.from_email,
        to_email: reply.to_email,
        subject: cleanedSubject,
        message: cleanedMessage,
        product_name: reply.product_name,
        reply_date: reply.reply_date || reply.responded_at,
        company_name: reply.company_name,
        contact_name: reply.contact_name,
        country: reply.country,
        status: reply.status,
        template_used: reply.template_used,
        response: reply.response,
        responded_at: reply.responded_at,
        sent_at: reply.sent_at
      };
    });

    res.json({
      success: true,
      count: cleanedResults.length,
      data: cleanedResults
    });

  } catch (error) {
    console.error("Error fetching buyer details:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching buyer details",
      error: error.message
    });
  }
});

// GET /api/replyhistory/:id - Get single email reply by ID
router.get('/api/replyhistory/:id', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const { id } = req.params;

    const query = `
      SELECT 
        id,
        batch_id,
        from_email,
        to_email,
        subject,
        message,
        product_name,
        reply_date,
        company_name,
        contact_name,
        country,
        status,
        template_used,
        response,
        responded_at,
        sent_at
      FROM email_history_companies
      WHERE id = ?
      LIMIT 1
    `;

    const [results] = await pool.query(query, [id]);

    if (results.length === 0) {
      return res.status(404).json({ success: false, message: "Email reply not found" });
    }

    const reply = results[0];

    let cleanedSubject = reply.subject || '';
    cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
    cleanedSubject = cleanedSubject.replace(/^Re:\s*/, '');

    let cleanedMessage = reply.message || '';
    const onIndex = cleanedMessage.indexOf('\nOn');
    if (onIndex !== -1) {
      cleanedMessage = cleanedMessage.substring(0, onIndex).trim();
    }

    cleanedMessage = cleanedMessage
      .replace(/\\u003C/g, '<')
      .replace(/\\u003E/g, '>')
      .trim();

    res.json({
      success: true,
      data: {
        id: reply.id,
        batch_id: reply.batch_id,
        from_email: reply.from_email,
        to_email: reply.to_email,
        subject: cleanedSubject,
        message: cleanedMessage,
        product_name: reply.product_name,
        reply_date: reply.reply_date,
        company_name: reply.company_name,
        contact_name: reply.contact_name,
        country: reply.country,
        status: reply.status,
        template_used: reply.template_used,
        response: reply.response,
        responded_at: reply.responded_at
      }
    });

  } catch (error) {
    console.error("Error fetching email reply:", error);
    res.status(500).json({ success: false, message: "Error fetching email reply", error: error.message });
  }
});

module.exports = router;