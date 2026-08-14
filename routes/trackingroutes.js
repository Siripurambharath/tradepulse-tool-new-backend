const express = require('express');
const router = express.Router();

/* ─────────────────────────────────────────────
   GET /api/tracking/counts
───────────────────────────────────────────── */
router.get('/api/tracking/counts', async (req, res) => {
  const pool = req.app.get('pool');
  const { seller_id } = req.query;

  if (!seller_id) {
    return res.status(400).json({
      success: false,
      error: 'seller_id is required',
    });
  }

  try {
    const [results] = await pool.query(
      `
      SELECT 
        (SELECT COUNT(DISTINCT buyer_id) FROM email_history_companies 
         WHERE seller_id = ? AND status = 'sent') AS sent,
        
        (SELECT COUNT(DISTINCT buyer_id) FROM email_history_companies 
         WHERE seller_id = ? AND message IS NOT NULL AND message <> '' AND reply_date IS NOT NULL) AS replied,
        
        (SELECT COUNT(DISTINCT buyer_id) FROM email_history_companies 
         WHERE seller_id = ? AND response = 'interested') AS interested,
        
        (SELECT COUNT(DISTINCT buyer_id) FROM email_history_companies 
         WHERE seller_id = ? AND response = 'not_interested') AS not_interested,
        
        (SELECT COUNT(DISTINCT buyer_id) FROM email_history_companies 
         WHERE seller_id = ?) AS total_contacted
    `,
      [seller_id, seller_id, seller_id, seller_id, seller_id]
    );

    const data = results[0] || {};

    res.json({
      success: true,
      data: {
        sent: data.sent || 0,
        replied: data.replied || 0,
        interested: data.interested || 0,
        not_interested: data.not_interested || 0,
      },
      total: {
        all: data.total_contacted || 0,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

router.get('/api/tracking/page', async (req, res) => {
  const pool = req.app.get('pool');
  const { seller_id, page = 1, limit = 10, search = '' } = req.query;

  if (!seller_id) {
    return res.status(400).json({
      success: false,
      error: 'seller_id is required',
    });
  }

  try {
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    // Build WHERE clause with search
    let whereClause = 'WHERE seller_id = ?';
    let params = [seller_id];

    if (search && search.trim() !== '') {
      const searchPattern = `%${search}%`;
      whereClause += ` AND (
        company_name LIKE ? OR 
        country LIKE ? OR 
        product_name LIKE ? OR 
        contact_name LIKE ? OR 
        email LIKE ? OR
        hsn_code LIKE ?
      )`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
    }

    // Get total count with search
    const [[totalResult]] = await pool.query(
      `
      SELECT COUNT(*) AS total
      FROM email_history_companies
      ${whereClause}
    `,
      params
    );

    const totalContacted = totalResult.total || 0;

    // Get paginated data with search
    const [allData] = await pool.query(
      `
      SELECT
        id,
        buyer_id,
        company_name,
        country,
        contact_name,
        email,
        product_name,
        sent_at,
        reply_date,
        responded_at,
        response,
        status,
        template_used,
        subject,
        message,
        hsn_code,
        CASE
          WHEN response = 'interested' THEN 'interested'
          WHEN response = 'not_interested' THEN 'not_interested'
          WHEN reply_date IS NOT NULL AND response IS NULL THEN 'replied'
          WHEN status = 'sent' AND response IS NULL AND reply_date IS NULL THEN 'sent'
          ELSE 'sent'
        END AS current_status,
        COALESCE(responded_at, reply_date, sent_at) AS last_interaction
      FROM email_history_companies
      ${whereClause}
      ORDER BY sent_at DESC
      LIMIT ? OFFSET ?
    `,
      [...params, limitNum, offset]
    );

    // Separate data by status
    const sent = allData.filter((item) => item.current_status === 'sent');
    const replied = allData.filter((item) => item.current_status === 'replied');
    const interested = allData.filter((item) => item.current_status === 'interested');
    const not_interested = allData.filter((item) => item.current_status === 'not_interested');

    // Get counts with search
    const [[countsResult]] = await pool.query(
      `
      SELECT
        SUM(CASE 
          WHEN response = 'interested' THEN 1 
          WHEN response = 'not_interested' THEN 1 
          WHEN reply_date IS NOT NULL AND response IS NULL THEN 1 
          WHEN status = 'sent' AND response IS NULL AND reply_date IS NULL THEN 1 
          ELSE 0 
        END) AS total_emails,
        SUM(CASE WHEN response = 'interested' THEN 1 ELSE 0 END) AS interested_count,
        SUM(CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END) AS not_interested_count,
        SUM(CASE WHEN reply_date IS NOT NULL AND response IS NULL THEN 1 ELSE 0 END) AS replied_count,
        SUM(CASE WHEN status = 'sent' AND response IS NULL AND reply_date IS NULL THEN 1 ELSE 0 END) AS sent_count
      FROM email_history_companies
      ${whereClause}
    `,
      params
    );

    // Calculate interaction count for each buyer
    const buyerInteractionCounts = {};
    allData.forEach(item => {
      const key = item.buyer_id;
      if (!buyerInteractionCounts[key]) {
        buyerInteractionCounts[key] = 0;
      }
      buyerInteractionCounts[key]++;
    });

    // Add interaction_count to each item
    const addInteractionCount = (items) => {
      return items.map(item => ({
        ...item,
        interaction_count: buyerInteractionCounts[item.buyer_id] || 0
      }));
    };

    res.json({
      success: true,
      data: {
        sent: addInteractionCount(sent),
        replied: addInteractionCount(replied),
        interested: addInteractionCount(interested),
        not_interested: addInteractionCount(not_interested),
      },
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(totalContacted / limitNum),
        totalItems: totalContacted,
        itemsPerPage: limitNum,
      },
      counts: {
        sent: countsResult.sent_count || 0,
        replied: countsResult.replied_count || 0,
        interested: countsResult.interested_count || 0,
        not_interested: countsResult.not_interested_count || 0,
      },
    });
  } catch (err) {
    console.error('GET /api/tracking/page:', err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});
/* ─────────────────────────────────────────────
   GET /api/tracking/buyer/:id
───────────────────────────────────────────── */
router.get('/api/tracking/buyer/:id', async (req, res) => {
  const pool = req.app.get('pool');
  const buyerId = req.params.id;
  const sellerId = req.query.sellerId;

  try {
    if (!sellerId) {
      return res.status(400).json({
        success: false,
        message: 'sellerId is required',
      });
    }

    const [buyerInfoResult] = await pool.query(
      `
      SELECT 
        b.id as buyer_id,
        b.company_name,
        b.country,
        b.product,
        b.hsn_code,
        GROUP_CONCAT(DISTINCT be.email SEPARATOR ', ') as emails,
        GROUP_CONCAT(DISTINCT bc.contact_number SEPARATOR ', ') as contacts
      FROM buyers b
      LEFT JOIN buyer_emails be ON b.id = be.buyer_id
      LEFT JOIN buyer_contacts bc ON b.id = bc.buyer_id
      WHERE b.id = ?
      GROUP BY b.id
    `,
      [buyerId]
    );

    if (buyerInfoResult.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Buyer not found',
      });
    }

    const buyerInfo = buyerInfoResult[0];

    const [communications] = await pool.query(
      `
      SELECT 
        id,
        buyer_id,
        batch_id,
        company_name,
        country,
        contact_name,
        email as from_email,
        to_email,
        subject,
        message,
        product_name,
        sent_at,
        reply_date,
        responded_at,
        status,
        template_used,
        response,
        seller_id,
        hsn_code,
        'email' as record_type
      FROM email_history_companies
      WHERE buyer_id = ? AND seller_id = ?
      ORDER BY COALESCE(sent_at, reply_date, responded_at) DESC
    `,
      [buyerId, sellerId]
    );

    const processedCommunications = communications.map((comm) => {
      let cleanedSubject = comm.subject || '';
      let cleanedMessage = comm.message || '';

      cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
      cleanedSubject = cleanedSubject.replace(/^Re:\s*/i, '');

      if (cleanedMessage) {
        const onIndex = cleanedMessage.indexOf('\nOn ');
        if (onIndex !== -1) {
          cleanedMessage = cleanedMessage.substring(0, onIndex).trim();
        }

        const wroteIndex = cleanedMessage.indexOf('wrote:');
        if (wroteIndex !== -1) {
          cleanedMessage = cleanedMessage.substring(0, wroteIndex).trim();
        }

        cleanedMessage = cleanedMessage
          .replace(/\\u003C/g, '<')
          .replace(/\\u003E/g, '>')
          .replace(/\[[^\]]*\]/g, '')
          .replace(/https?:\/\/[^\s]+/g, '')
          .replace(/\n\s*\n\s*\n/g, '\n\n')
          .trim();
      }

      let display_status = 'Unknown';
      if (comm.response === 'interested') {
        display_status = 'Interested';
      } else if (comm.response === 'not_interested') {
        display_status = 'Not Interested';
      } else if (comm.reply_date && comm.reply_date !== null) {
        display_status = 'Replied';
      } else if (comm.status === 'sent' || comm.status === 'Manual Entry') {
        display_status = 'Sent';
      }

      return {
        ...comm,
        subject: cleanedSubject || 'No Subject',
        message: cleanedMessage || 'No message content',
        display_status,
        date: comm.sent_at || comm.reply_date || comm.responded_at || comm.sent_at,
      };
    });

    const summary = {
      total: processedCommunications.length,
      sent: processedCommunications.filter((c) => c.display_status === 'Sent').length,
      replied: processedCommunications.filter((c) => c.display_status === 'Replied').length,
      interested: processedCommunications.filter((c) => c.display_status === 'Interested').length,
      not_interested: processedCommunications.filter((c) => c.display_status === 'Not Interested')
        .length,
      last_activity: processedCommunications[0]?.date || null,
    };

    res.json({
      success: true,
      data: processedCommunications,
      buyer_info: {
        buyer_id: buyerInfo.buyer_id,
        company_name: buyerInfo.company_name,
        country: buyerInfo.country,
        product_name: buyerInfo.product,
        contact_name: buyerInfo.contacts?.split(',')[0]?.trim() || 'N/A',
        email: buyerInfo.emails?.split(',')[0]?.trim() || 'N/A',
        all_emails: buyerInfo.emails,
        all_contacts: buyerInfo.contacts,
        seller_id: sellerId,
        hsn_code: buyerInfo.hsn_code || '',
      },
      summary: summary,
    });
  } catch (err) {
    console.error('GET /api/tracking/buyer/:id error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/* ─────────────────────────────────────────────
   GET /api/tracking/buyer/:buyerId (with pagination)
───────────────────────────────────────────── */
router.get('/api/tracking/buyer/:buyerId', async (req, res) => {
  const pool = req.app.get('pool');
  const { buyerId } = req.params;
  const { sellerId, page = 1, limit = 10 } = req.query;

  if (!buyerId) {
    return res.status(400).json({
      success: false,
      message: 'buyerId is required',
    });
  }

  if (!sellerId) {
    return res.status(400).json({
      success: false,
      message: 'sellerId is required',
    });
  }

  try {
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    const [buyerInfo] = await pool.query(
      `
      SELECT 
        b.id as buyer_id,
        b.company_name,
        b.country,
        b.product as product_name,
        b.hsn_code,
        GROUP_CONCAT(DISTINCT bc.contact_number SEPARATOR ', ') as contacts,
        GROUP_CONCAT(DISTINCT be.email SEPARATOR ', ') as emails,
        b.buyer_date
      FROM buyers b
      LEFT JOIN buyer_contacts bc ON b.id = bc.buyer_id
      LEFT JOIN buyer_emails be ON b.id = be.buyer_id
      WHERE b.id = ?
      GROUP BY b.id
    `,
      [buyerId]
    );

    if (buyerInfo.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Buyer not found',
      });
    }

    const buyer = buyerInfo[0];

    const [countResult] = await pool.query(
      `
      SELECT COUNT(*) as total
      FROM email_history_companies
      WHERE buyer_id = ? AND seller_id = ?
    `,
      [buyerId, sellerId]
    );

    const total = countResult[0]?.total || 0;

    const [communications] = await pool.query(
      `
      SELECT 
        id,
        buyer_id,
        batch_id,
        company_name,
        country,
        contact_name,
        email as from_email,
        to_email,
        subject,
        message,
        product_name,
        sent_at,
        reply_date,
        responded_at,
        status,
        template_used,
        response,
        seller_id,
        hsn_code,
        'email' as record_type
      FROM email_history_companies
      WHERE buyer_id = ? AND seller_id = ?
      ORDER BY COALESCE(sent_at, reply_date, responded_at) DESC
      LIMIT ? OFFSET ?
    `,
      [buyerId, sellerId, limitNum, offset]
    );

    const processedCommunications = communications.map((comm) => {
      let cleanedSubject = comm.subject || '';
      let cleanedMessage = comm.message || '';

      cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
      cleanedSubject = cleanedSubject.replace(/^Re:\s*/i, '');

      if (cleanedMessage) {
        const onIndex = cleanedMessage.indexOf('\nOn ');
        if (onIndex !== -1) {
          cleanedMessage = cleanedMessage.substring(0, onIndex).trim();
        }
        const wroteIndex = cleanedMessage.indexOf('wrote:');
        if (wroteIndex !== -1) {
          cleanedMessage = cleanedMessage.substring(0, wroteIndex).trim();
        }
        cleanedMessage = cleanedMessage
          .replace(/\\u003C/g, '<')
          .replace(/\\u003E/g, '>')
          .replace(/\[[^\]]*\]/g, '')
          .replace(/https?:\/\/[^\s]+/g, '')
          .replace(/\n\s*\n\s*\n/g, '\n\n')
          .trim();
      }

      let display_status = 'Unknown';
      if (comm.response === 'interested') {
        display_status = 'Interested';
      } else if (comm.response === 'not_interested') {
        display_status = 'Not Interested';
      } else if (comm.message && comm.message.trim() !== '' && comm.reply_date) {
        display_status = 'Replied';
      } else if (comm.status === 'sent') {
        display_status = 'Sent';
      }

      return {
        ...comm,
        subject: cleanedSubject,
        message: cleanedMessage,
        display_status,
        date: comm.sent_at || comm.reply_date || comm.responded_at,
      };
    });

    const summary = {
      total: processedCommunications.length,
      sent: processedCommunications.filter((c) => c.display_status === 'Sent').length,
      replied: processedCommunications.filter((c) => c.display_status === 'Replied').length,
      interested: processedCommunications.filter((c) => c.display_status === 'Interested').length,
      not_interested: processedCommunications.filter((c) => c.display_status === 'Not Interested')
        .length,
      last_activity: processedCommunications[0]?.date || null,
    };

    res.json({
      success: true,
      data: processedCommunications,
      buyer_info: {
        buyer_id: buyer.buyer_id,
        company_name: buyer.company_name,
        country: buyer.country,
        product_name: buyer.product_name,
        contact_name: buyer.contacts?.split(',')[0]?.trim() || 'N/A',
        email: buyer.emails?.split(',')[0]?.trim() || 'N/A',
        all_emails: buyer.emails,
        all_contacts: buyer.contacts,
        hsn_code: buyer.hsn_code || '',
      },
      summary: summary,
      pagination: {
        total: total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error('GET /api/tracking/buyer/:buyerId error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/* ─────────────────────────────────────────────
   GET /api/tracking/buyer/:buyerId/search
───────────────────────────────────────────── */
router.get('/api/tracking/buyer/:buyerId/search', async (req, res) => {
  const pool = req.app.get('pool');
  const { buyerId } = req.params;
  const { sellerId, search = '', page = 1, limit = 10 } = req.query;

  if (!buyerId) {
    return res.status(400).json({
      success: false,
      message: 'buyerId is required',
    });
  }

  if (!sellerId) {
    return res.status(400).json({
      success: false,
      message: 'sellerId is required',
    });
  }

  try {
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    let whereConditions = ['buyer_id = ?', 'seller_id = ?'];
    let params = [buyerId, sellerId];

    if (search && search.trim() !== '') {
      const searchPattern = `%${search}%`;
      whereConditions.push(`(
        subject LIKE ? OR 
        message LIKE ? OR 
        response LIKE ? OR 
        template_used LIKE ? OR 
        company_name LIKE ? OR
        to_email LIKE ? OR
        contact_name LIKE ? OR
        hsn_code LIKE ?
      )`);
      params.push(
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern,
        searchPattern
      );
    }

    const whereClause = `WHERE ${whereConditions.join(' AND ')}`;

    const countQuery = `
      SELECT COUNT(*) as total
      FROM email_history_companies
      ${whereClause}
    `;
    const [countResult] = await pool.query(countQuery, params);
    const total = countResult[0]?.total || 0;

    const query = `
      SELECT 
        id,
        buyer_id,
        batch_id,
        company_name,
        country,
        contact_name,
        email as from_email,
        to_email,
        subject,
        message,
        product_name,
        sent_at,
        reply_date,
        responded_at,
        status,
        template_used,
        response,
        seller_id,
        hsn_code,
        'email' as record_type,
        COALESCE(sent_at, reply_date, responded_at) as date
      FROM email_history_companies
      ${whereClause}
      ORDER BY COALESCE(sent_at, reply_date, responded_at) DESC
      LIMIT ? OFFSET ?
    `;

    const queryParams = [...params, limitNum, offset];
    const [communications] = await pool.query(query, queryParams);

    const processedCommunications = communications.map((comm) => {
      let cleanedSubject = comm.subject || '';
      let cleanedMessage = comm.message || '';

      cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
      cleanedSubject = cleanedSubject.replace(/^Re:\s*/i, '');

      if (cleanedMessage) {
        const onIndex = cleanedMessage.indexOf('\nOn ');
        if (onIndex !== -1) {
          cleanedMessage = cleanedMessage.substring(0, onIndex).trim();
        }
        const wroteIndex = cleanedMessage.indexOf('wrote:');
        if (wroteIndex !== -1) {
          cleanedMessage = cleanedMessage.substring(0, wroteIndex).trim();
        }
        cleanedMessage = cleanedMessage
          .replace(/\\u003C/g, '<')
          .replace(/\\u003E/g, '>')
          .replace(/\[[^\]]*\]/g, '')
          .replace(/https?:\/\/[^\s]+/g, '')
          .replace(/\n\s*\n\s*\n/g, '\n\n')
          .trim();
      }

      let display_status = 'Unknown';
      if (comm.response === 'interested') {
        display_status = 'Interested';
      } else if (comm.response === 'not_interested') {
        display_status = 'Not Interested';
      } else if (comm.message && comm.message.trim() !== '' && comm.reply_date) {
        display_status = 'Replied';
      } else if (comm.status === 'sent') {
        display_status = 'Sent';
      }

      return {
        ...comm,
        subject: cleanedSubject,
        message: cleanedMessage,
        display_status,
        date: comm.sent_at || comm.reply_date || comm.responded_at,
      };
    });

    const summary = {
      total: processedCommunications.length,
      sent: processedCommunications.filter((c) => c.display_status === 'Sent').length,
      replied: processedCommunications.filter((c) => c.display_status === 'Replied').length,
      interested: processedCommunications.filter((c) => c.display_status === 'Interested').length,
      not_interested: processedCommunications.filter((c) => c.display_status === 'Not Interested')
        .length,
      last_activity: processedCommunications[0]?.date || null,
    };

    const [buyerInfo] = await pool.query(
      `
      SELECT 
        b.id as buyer_id,
        b.company_name,
        b.country,
        b.product as product_name,
        b.hsn_code,
        GROUP_CONCAT(DISTINCT bc.contact_number SEPARATOR ', ') as contacts,
        GROUP_CONCAT(DISTINCT be.email SEPARATOR ', ') as emails
      FROM buyers b
      LEFT JOIN buyer_contacts bc ON b.id = bc.buyer_id
      LEFT JOIN buyer_emails be ON b.id = be.buyer_id
      WHERE b.id = ?
      GROUP BY b.id
    `,
      [buyerId]
    );

    const buyer = buyerInfo[0] || {};

    res.json({
      success: true,
      data: processedCommunications,
      buyer_info: {
        buyer_id: buyer.buyer_id,
        company_name: buyer.company_name || 'Unknown',
        country: buyer.country || 'Unknown',
        product_name: buyer.product_name || 'Unknown',
        contact_name: buyer.contacts?.split(',')[0]?.trim() || 'N/A',
        email: buyer.emails?.split(',')[0]?.trim() || 'N/A',
        all_emails: buyer.emails || '',
        all_contacts: buyer.contacts || '',
        hsn_code: buyer.hsn_code || '',
      },
      summary: summary,
      pagination: {
        total: total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
      search: search || null,
    });
  } catch (err) {
    console.error('GET /api/tracking/buyer/:buyerId/search error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/* ─────────────────────────────────────────────
   GET /track-response
───────────────────────────────────────────── */
router.get('/track-response', async (req, res) => {
  const pool = req.app.get('pool');
  const { batchId, email, response } = req.query;

  console.log('📩 /track-response hit:', { batchId, email, response });

  if (!batchId || !email || !['interested', 'not_interested'].includes(response)) {
    console.log('❌ Validation failed:', { batchId, email, response });
    return res.status(400).send(`
      <html><body style="font-family:Arial;text-align:center;padding:60px;">
        <h2>❌ Invalid Request</h2>
        <p>batchId: ${batchId}</p>
        <p>email: ${email}</p>
        <p>response: ${response}</p>
      </body></html>
    `);
  }

  try {
    const [existing] = await pool.query(
      `SELECT id, email, response, from_email, status FROM email_history_companies 
       WHERE batch_id = ? AND email = ?`,
      [batchId, email]
    );

    console.log('🔍 DB lookup result:', existing);

    if (existing.length === 0) {
      console.log('❌ No record found for:', { batchId, email });
      return res.status(404).send(`
        <html><body style="font-family:Arial;text-align:center;padding:60px;">
          <h2>❌ Record Not Found</h2>
          <p>No record found for batchId: <strong>${batchId}</strong></p>
          <p>email: <strong>${email}</strong></p>
          <p>Check if the email was inserted into email_history_companies table.</p>
        </body></html>
      `);
    }

    if (existing[0].response !== null) {
      return res.send(`
        <html><body style="font-family:Arial;text-align:center;padding:60px;">
          <h2>⚠️ Already Responded</h2>
          <p>Your answer: <strong>${existing[0].response.replace('_', ' ')}</strong></p>
        </body></html>
      `);
    }

    const yourEmail = process.env.EMAIL_USER;

    const [updateResult] = await pool.query(
      `UPDATE email_history_companies
       SET response = ?, 
           responded_at = NOW(),
           from_email = ?,
           to_email = ?
       WHERE batch_id = ? AND email = ?`,
      [response, email, yourEmail, batchId, email]
    );

    console.log('✅ Update result:', updateResult);

    if (updateResult.affectedRows === 0) {
      console.log('❌ Update ran but affected 0 rows');
      return res.status(500).send(`
        <html><body style="font-family:Arial;text-align:center;padding:60px;">
          <h2>❌ Update Failed</h2>
          <p>Query ran but no rows were updated.</p>
          <p>batchId: ${batchId} | email: ${email}</p>
        </body></html>
      `);
    }

    const label = response === 'interested' ? '✅ Interested' : '❌ Not Interested';
    const color = response === 'interested' ? '#22c55e' : '#ef4444';

    return res.send(`
      <html><body style="font-family:Arial;text-align:center;padding:60px;">
        <h2 style="color:${color};">${label}</h2>
        <p>Thank you! Your response has been recorded.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('💥 track-response error:', err);
    return res.status(500).send(`
      <html><body style="font-family:Arial;text-align:center;padding:60px;">
        <h2>💥 Server Error</h2>
        <p><strong>${err.message}</strong></p>
        <pre style="text-align:left;background:#f3f4f6;padding:16px;">${err.stack}</pre>
      </body></html>
    `);
  }
});

module.exports = router;