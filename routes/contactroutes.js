// routes/contactRoutes.js
const express = require('express');
const router = express.Router();

router.get('/api/contacts', async (req, res) => {
  const pool = req.app.get('pool');
  const {
    seller_id,
    search = '',
    template = '',
    response_type = '',
    page = 1,
    limit = 10,
  } = req.query;
 
  if (!seller_id) {
    return res.status(400).json({ success: false, message: 'seller_id is required' });
  }
 
  try {
    const offset = (Number(page) - 1) * Number(limit);
    const limitNum = Number(limit);
 
    // Build WHERE conditions
    let whereConditions = ['e.seller_id = ?'];
    let values = [seller_id];
 
    // Search filter - include hsn_code in search
    if (search) {
      const searchPattern = `%${search}%`;
      whereConditions.push(`(
        e.company_name LIKE ? OR 
        e.product_name LIKE ? OR 
        e.contact_name LIKE ? OR 
        e.email LIKE ? OR
        e.hsn_code LIKE ?  
      )`);
      values.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
    }
 
    // Template filter
    if (template && template !== 'all') {
      whereConditions.push(`e.template_used = ?`);
      values.push(template);
    }
 
    // Response type filter
    if (response_type && response_type !== 'all') {
      if (response_type === 'interested') {
        whereConditions.push(`e.response = 'interested'`);
      } else if (response_type === 'not_interested') {
        whereConditions.push(`e.response = 'not_interested'`);
      } else if (response_type === 'replied') {
        whereConditions.push(`(e.reply_date IS NOT NULL OR e.responded_at IS NOT NULL)`);
      } else if (response_type === 'sent') {
        whereConditions.push(`e.status = 'sent'`);
      }
    }
 
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
 
    // Get total count
    const countQuery = `
      SELECT COUNT(DISTINCT e.buyer_id) as total
      FROM email_history_companies e
      ${whereClause}
    `;
 
    const [countResult] = await pool.query(countQuery, values);
    const total = countResult[0]?.total || 0;
 
    // Get paginated contacts - include hsn_code
    const query = `
      SELECT 
        e.buyer_id,
        e.contact_name,
        e.from_email,
        e.company_name,
        e.product_name,
        e.template_used,
        e.email,
        e.reply_date,
        e.responded_at,
        e.sent_at,
        e.response,
        e.status,
        e.hsn_code 
      FROM email_history_companies e
      ${whereClause}
      ORDER BY COALESCE(e.reply_date, e.responded_at, e.sent_at) DESC
      LIMIT ? OFFSET ?
    `;
 
    const [results] = await pool.query(query, [...values, limitNum, offset]);
 
    if (results.length === 0) {
      return res.json({
        success: true,
        data: [],
        total: 0,
        pagination: {
          total: 0,
          page: Number(page),
          limit: limitNum,
          totalPages: 0,
        },
      });
    }
 
    // Process results
    const contactMap = new Map();
 
    results.forEach((row) => {
      if (!contactMap.has(row.buyer_id)) {
        contactMap.set(row.buyer_id, {
          buyer_id: row.buyer_id,
          contact_name: row.contact_name || 'Unknown',
          from_email: row.from_email || '',
          company_name: row.company_name || '',
          product_name: row.product_name || '',
          template_used: row.template_used || '',
          phone: row.contact_name && row.contact_name.match(/^\+?\d+$/) ? row.contact_name : '',
          interaction_count: 0,
          response: null,
          email: row.email || row.from_email || '',
          last_interaction: row.sent_at || row.reply_date || row.responded_at,
          has_interested: false,
          has_not_interested: false,
          has_replied: false,
          hsn_code: row.hsn_code || '',
        });
      }
 
      const contact = contactMap.get(row.buyer_id);
      contact.interaction_count++;
 
      if (row.response === 'interested') {
        contact.has_interested = true;
        contact.response = 'interested';
      } else if (row.response === 'not_interested') {
        contact.has_not_interested = true;
        contact.response = 'not_interested';
      } else if (row.reply_date || row.responded_at) {
        contact.has_replied = true;
        contact.response = 'replied';
      }
 
      const recordDate = row.reply_date || row.responded_at || row.sent_at;
      if (
        recordDate &&
        (!contact.last_interaction || new Date(recordDate) > new Date(contact.last_interaction))
      ) {
        contact.last_interaction = recordDate;
      }
    });
 
    const cleanedResults = Array.from(contactMap.values()).map((contact) => ({
      ...contact,
      response: contact.has_interested
        ? 'interested'
        : contact.has_not_interested
        ? 'not_interested'
        : contact.has_replied
        ? 'replied'
        : null,
    }));
 
    cleanedResults.sort((a, b) => {
      return new Date(b.last_interaction) - new Date(a.last_interaction);
    });
 
    res.json({
      success: true,
      data: cleanedResults,
      total: total,
      pagination: {
        total: total,
        page: Number(page),
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching contacts',
      error: error.message,
    });
  }
});

/* ─────────────────────────────────────────────
   GET /api/contacts/stats
───────────────────────────────────────────── */
router.get('/api/contacts/stats', async (req, res) => {
  const pool = req.app.get('pool');
  const { seller_id } = req.query;

  if (!seller_id) {
    return res.status(400).json({ success: false, message: 'seller_id is required' });
  }

  try {
    const [totalResult] = await pool.query(
      `
      SELECT COUNT(DISTINCT buyer_id) as total
      FROM email_history_companies
      WHERE seller_id = ?
    `,
      [seller_id]
    );

    const [interestedResult] = await pool.query(
      `
      SELECT COUNT(DISTINCT buyer_id) as interested
      FROM email_history_companies
      WHERE seller_id = ? AND response = 'interested'
    `,
      [seller_id]
    );

    const [notInterestedResult] = await pool.query(
      `
      SELECT COUNT(DISTINCT buyer_id) as not_interested
      FROM email_history_companies
      WHERE seller_id = ? AND response = 'not_interested'
    `,
      [seller_id]
    );

    const [pendingResult] = await pool.query(
      `
      SELECT COUNT(DISTINCT buyer_id) as pending
      FROM email_history_companies
      WHERE seller_id = ? AND (response IS NULL OR response = '')
    `,
      [seller_id]
    );

    const total = totalResult[0]?.total || 0;
    const interested = interestedResult[0]?.interested || 0;
    const not_interested = notInterestedResult[0]?.not_interested || 0;
    const pending = pendingResult[0]?.pending || 0;

    console.log('Stats for seller:', seller_id, { total, interested, not_interested, pending });

    res.json({
      success: true,
      data: {
        total: total,
        interested: interested,
        not_interested: not_interested,
        pending: pending,
      },
    });
  } catch (error) {
    console.error('Error fetching contacts stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching contacts stats',
      error: error.message,
    });
  }
});

/* ─────────────────────────────────────────────
   GET /api/contacts/templates
───────────────────────────────────────────── */
router.get('/api/contacts/templates', async (req, res) => {
  const pool = req.app.get('pool');
  const { seller_id } = req.query;

  if (!seller_id) {
    return res.status(400).json({ success: false, message: 'seller_id is required' });
  }

  try {
    const [templates] = await pool.query(
      `
      SELECT DISTINCT template_used as template
      FROM email_history_companies 
      WHERE seller_id = ? 
      AND template_used IS NOT NULL 
      AND template_used != ''
      ORDER BY template_used
      LIMIT 100
    `,
      [seller_id]
    );

    res.json(templates);
  } catch (error) {
    console.error('Error fetching contacts templates:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching templates',
      error: error.message,
    });
  }
});

/* ─────────────────────────────────────────────
   GET /api/contacts/search
───────────────────────────────────────────── */
router.get('/api/contacts/search', async (req, res) => {
  const pool = req.app.get('pool');
  const { seller_id, q = '', page = 1, limit = 10 } = req.query;

  if (!seller_id) {
    return res.status(400).json({ success: false, message: 'seller_id is required' });
  }

  try {
    const offset = (Number(page) - 1) * Number(limit);
    const limitNum = Number(limit);

    const searchPattern = `%${q}%`;

    const [results] = await pool.query(
      `
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
        MAX(CASE WHEN LOWER(response) = 'not_interested' THEN 1 ELSE 0 END) as has_not_interested,
        MAX(CASE WHEN reply_date IS NOT NULL OR responded_at IS NOT NULL THEN 1 ELSE 0 END) as has_replied,
        MAX(COALESCE(reply_date, responded_at, sent_at)) as last_interaction,
        MAX(email) as email
      FROM email_history_companies
      WHERE seller_id = ?
        AND (
          company_name LIKE ? OR 
          country LIKE ? OR 
          product_name LIKE ? OR 
          contact_name LIKE ? OR 
          to_email LIKE ? OR
          from_email LIKE ? OR
          email LIKE ?
        )
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
      LIMIT ? OFFSET ?
    `,
      [
        seller_id,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        limitNum,
        offset,
      ]
    );

    const [countResult] = await pool.query(
      `
      SELECT COUNT(DISTINCT buyer_id) as total
      FROM email_history_companies
      WHERE seller_id = ?
        AND (
          company_name LIKE ? OR 
          country LIKE ? OR 
          product_name LIKE ? OR 
          contact_name LIKE ? OR 
          to_email LIKE ? OR
          from_email LIKE ? OR
          email LIKE ?
        )
    `,
      [
        seller_id,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
      ]
    );

    const cleanedResults = results.map((contact) => ({
      buyer_id: contact.buyer_id,
      contact_name: contact.contact_name || 'Unknown',
      from_email: contact.from_email || '',
      to_email: contact.to_email || '',
      company_name: contact.company_name || '',
      country: contact.country || '',
      product_name: contact.product_name || '',
      template_used: contact.template_used || '',
      phone:
        contact.contact_name && contact.contact_name.match(/^\+?\d+$/)
          ? contact.contact_name
          : '',
      interaction_count: contact.interaction_count,
      status: contact.has_sent ? 'sent' : 'pending',
      response: contact.has_interested
        ? 'interested'
        : contact.has_not_interested
        ? 'not_interested'
        : contact.has_replied
        ? 'replied'
        : null,
      email: contact.email || contact.from_email || '',
      last_interaction: contact.last_interaction,
    }));

    res.json({
      success: true,
      data: cleanedResults,
      total: countResult[0]?.total || 0,
      pagination: {
        total: countResult[0]?.total || 0,
        page: Number(page),
        limit: limitNum,
        totalPages: Math.ceil((countResult[0]?.total || 0) / limitNum),
      },
    });
  } catch (error) {
    console.error('Error searching contacts:', error);
    res.status(500).json({
      success: false,
      message: 'Error searching contacts',
      error: error.message,
    });
  }
});



router.get('/api/replyhistory/:buyerId', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const buyerId = req.params.buyerId;
    const sellerId = req.query.sellerId;

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
        sent_at,
        hsn_code 
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
        sent_at: reply.sent_at,
        hsn_code: reply.hsn_code || '' 
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
        sent_at,
        hsn_code  
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
        responded_at: reply.responded_at,
        hsn_code: reply.hsn_code || '' 
      }
    });

  } catch (error) {
    console.error("Error fetching email reply:", error);
    res.status(500).json({ success: false, message: "Error fetching email reply", error: error.message });
  }
});


router.get('/api/replyhistory/:buyerId/stats', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const buyerId = req.params.buyerId;
    const sellerId = req.query.sellerId;
 
    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: 'sellerId is required',
      });
    }
 
    const query = `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN response = 'interested' THEN 1 ELSE 0 END) as interested,
        SUM(CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END) as not_interested,
        SUM(CASE WHEN response IS NULL OR response = '' THEN 1 ELSE 0 END) as pending
      FROM email_history_companies
      WHERE buyer_id = ? AND seller_id = ?
    `;
 
    const [results] = await pool.query(query, [buyerId, sellerId]);
 
    res.json({
      success: true,
      data: {
        total: results[0]?.total || 0,
        sent: results[0]?.sent || 0,
        interested: results[0]?.interested || 0,
        not_interested: results[0]?.not_interested || 0,
        pending: results[0]?.pending || 0,
      },
    });
  } catch (error) {
    console.error('Error fetching contact stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching contact stats',
      error: error.message,
    });
  }
});
module.exports = router;