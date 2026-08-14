
// -----------------------------------------------------------------------

const express = require('express');
const router = express.Router();

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/* ─────────────────────────────────────────────
   GET /history — batch list (paginated)
───────────────────────────────────────────── */
router.get('/history', async (req, res) => {
  const pool = req.app.get('pool');
  const {
    seller_id,
    page = 1,
    limit = 10,
    search = '',
    product = '',
  } = req.query;

  if (!seller_id) {
    return res.status(400).json({ error: 'seller_id is required' });
  }

  try {
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    let whereConditions = ['ehc.seller_id = ?'];
    let values = [seller_id];

    if (search) {
      whereConditions.push(`ehc.product_name LIKE ?`);
      values.push(`%${search}%`);
    }

    if (product) {
      whereConditions.push(`ehc.product_name = ?`);
      values.push(product);
    }

    const whereClause = whereConditions.join(' AND ');

    const [countResult] = await pool.query(
      `
      SELECT COUNT(DISTINCT ehc.batch_id) as total
      FROM email_history_companies ehc
      WHERE ${whereClause}
    `,
      values
    );
    const totalBatches = countResult[0]?.total || 0;

    const [batches] = await pool.query(
      `
      SELECT 
        ehc.batch_id,
        MAX(ehc.product_name) as product_name,
        MAX(ehc.sent_at) as sent_at,
        MAX(ehc.multiple_products) as multiple_products,
        MAX(ehc.template_used) as template_used,
        COUNT(*) as total_companies,
        SUM(CASE WHEN ehc.message IS NOT NULL AND ehc.message <> '' THEN 1 ELSE 0 END) as replied_count,
        SUM(CASE WHEN ehc.response = 'interested' THEN 1 ELSE 0 END) as interested_count,
        SUM(CASE WHEN ehc.response = 'not_interested' THEN 1 ELSE 0 END) as not_interested_count
      FROM email_history_companies ehc
      WHERE ${whereClause}
      GROUP BY ehc.batch_id
      ORDER BY MAX(ehc.sent_at) DESC
      LIMIT ? OFFSET ?
    `,
      [...values, limitNum, offset]
    );

    const historyData = [];

    for (const batch of batches) {
      const [companies] = await pool.query(
        `
        SELECT
          company_name,
          contact_name,
          email,
          sent_at,
          response,
          template_used,
          message,
          reply_date,
          subject,
          product_name
        FROM email_history_companies
        WHERE batch_id = ? AND seller_id = ?
        ORDER BY sent_at DESC
      `,
        [batch.batch_id, seller_id]
      );

      const companiesList = companies.map((row) => {
        const hasMessage = row.message && row.message.trim() !== '';
        const isInterested = row.response === 'interested';
        const isNotInterested = row.response === 'not_interested';

        let status = 'Email Sent';
        if (hasMessage && isInterested) status = 'Replied, Interested';
        else if (hasMessage && isNotInterested) status = 'Replied, Not Interested';
        else if (hasMessage) status = 'Replied';
        else if (isInterested) status = 'Interested';
        else if (isNotInterested) status = 'Not Interested';

        return {
          companyName: row.company_name,
          contactName: row.contact_name,
          email: row.email,
          sentAt: row.sent_at,
          response: row.response,
          respondedAt: row.reply_date,
          status,
          templateUsed: row.template_used,
          subject: row.subject,
          message: hasMessage ? row.message.split('\n')[0].trim() : null,
          product: row.product_name,
          hasReply: hasMessage,
          isInterested,
          isNotInterested,
        };
      });

      const mainProduct =
        batch.multiple_products === 1 ? 'General Products' : batch.product_name;

      historyData.push({
        id: batch.batch_id,
        product: mainProduct,
        multiple_products: batch.multiple_products,
        date: batch.sent_at,
        companies: companiesList,
        counts: {
          total: batch.total_companies,
          replied: batch.replied_count,
          interested: batch.interested_count,
          notInterested: batch.not_interested_count,
          emailSent: batch.total_companies - batch.replied_count,
        },
      });
    }

    res.json({
      success: true,
      total: totalBatches,
      data: historyData,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(totalBatches / limitNum),
        totalItems: totalBatches,
        itemsPerPage: limitNum,
      },
    });
  } catch (err) {
    console.error('GET /history error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────
   GET /history/stats
───────────────────────────────────────────── */
router.get('/history/stats', async (req, res) => {
  const pool = req.app.get('pool');
  const { seller_id } = req.query;

  if (!seller_id) {
    return res.status(400).json({ error: 'seller_id is required' });
  }

  try {
    const [batchResult] = await pool.query(
      `
      SELECT COUNT(DISTINCT batch_id) as total_entries
      FROM email_history_companies
      WHERE seller_id = ?
    `,
      [seller_id]
    );

    const [companyResult] = await pool.query(
      `
      SELECT COUNT(DISTINCT buyer_id) as total_companies
      FROM email_history_companies
      WHERE seller_id = ?
    `,
      [seller_id]
    );

    const [repliedResult] = await pool.query(
      `
      SELECT COUNT(DISTINCT buyer_id) as total_replied
      FROM email_history_companies
      WHERE seller_id = ? 
      AND (message IS NOT NULL AND message <> '')
    `,
      [seller_id]
    );

    const [interestedResult] = await pool.query(
      `
      SELECT COUNT(DISTINCT buyer_id) as total_interested
      FROM email_history_companies
      WHERE seller_id = ? AND response = 'interested'
    `,
      [seller_id]
    );

    const [notInterestedResult] = await pool.query(
      `
      SELECT COUNT(DISTINCT buyer_id) as total_not_interested
      FROM email_history_companies
      WHERE seller_id = ? AND response = 'not_interested'
    `,
      [seller_id]
    );

    const totalEntries = batchResult[0]?.total_entries || 0;
    const totalCompanies = companyResult[0]?.total_companies || 0;
    const totalReplied = repliedResult[0]?.total_replied || 0;
    const totalInterested = interestedResult[0]?.total_interested || 0;
    const totalNotInterested = notInterestedResult[0]?.total_not_interested || 0;

    res.json({
      success: true,
      data: {
        totalEntries,
        totalCompanies,
        totalReplied,
        totalInterested,
        totalNotInterested,
        responseRate:
          totalCompanies > 0 ? Math.round((totalReplied / totalCompanies) * 100) : 0,
        interestedRate:
          totalCompanies > 0 ? Math.round((totalInterested / totalCompanies) * 100) : 0,
      },
    });
  } catch (err) {
    console.error('GET /history/stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────
   GET /history/products
───────────────────────────────────────────── */
router.get('/history/products', async (req, res) => {
  const pool = req.app.get('pool');
  const { seller_id } = req.query;

  if (!seller_id) {
    return res.status(400).json({ error: 'seller_id is required' });
  }

  try {
    const [products] = await pool.query(
      `
      SELECT DISTINCT product_name as product
      FROM email_history_companies
      WHERE seller_id = ? 
      AND product_name IS NOT NULL 
      AND product_name <> ''
      ORDER BY product_name
    `,
      [seller_id]
    );

    res.json(products);
  } catch (err) {
    console.error('GET /history/products error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────
   GET /history/:id  — single batch detail (paginated companies)
───────────────────────────────────────────── */
router.get('/history/:id', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const { id } = req.params;
    const { seller_id, page = 1, limit = 10 } = req.query;

    if (!seller_id) {
      return res.status(400).json({
        success: false,
        message: 'seller_id is required',
      });
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    const [countResult] = await pool.query(
      `
      SELECT COUNT(*) as total
      FROM email_history_companies
      WHERE batch_id = ? AND seller_id = ?
    `,
      [id, seller_id]
    );
    const totalCompanies = countResult[0]?.total || 0;

    const [batchInfo] = await pool.query(
      `
      SELECT
        batch_id AS id,
        product_name AS product,
        multiple_products,
        MAX(sent_at) AS sent_at
      FROM email_history_companies
      WHERE batch_id = ? AND seller_id = ?
      GROUP BY batch_id, product_name, multiple_products
    `,
      [id, seller_id]
    );

    if (!batchInfo.length) {
      return res.status(404).json({
        success: false,
        message: 'History not found',
      });
    }

    const [results] = await pool.query(
      `
      SELECT
        company_name,
        contact_name,
        email,
        sent_at,
        response,
        template_used,
        message,
        reply_date,
        subject,
        product_name AS product,
        status
      FROM email_history_companies
      WHERE batch_id = ? AND seller_id = ?
      ORDER BY sent_at DESC
      LIMIT ? OFFSET ?
    `,
      [id, seller_id, limitNum, offset]
    );

    const [countsResult] = await pool.query(
      `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN message IS NOT NULL AND message <> '' THEN 1 ELSE 0 END) as replied,
        SUM(CASE WHEN response = 'interested' THEN 1 ELSE 0 END) as interested,
        SUM(CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END) as not_interested,
        SUM(CASE WHEN status = 'sent' OR response IS NULL THEN 1 ELSE 0 END) as emailSent
      FROM email_history_companies
      WHERE batch_id = ? AND seller_id = ?
    `,
      [id, seller_id]
    );

    const counts = countsResult[0] || {
      total: 0,
      replied: 0,
      interested: 0,
      not_interested: 0,
      emailSent: 0,
    };

    const companies = results.map((row) => {
      const hasMessage = row.message && row.message.trim() !== '';
      const isInterested = row.response === 'interested';
      const isNotInterested = row.response === 'not_interested';

      let status = 'Email Sent';
      if (hasMessage && isInterested) status = 'Replied, Interested';
      else if (hasMessage && isNotInterested) status = 'Replied, Not Interested';
      else if (hasMessage) status = 'Replied';
      else if (isInterested) status = 'Interested';
      else if (isNotInterested) status = 'Not Interested';

      return {
        companyName: row.company_name,
        contactName: row.contact_name,
        email: row.email,
        sentAt: row.sent_at,
        response: row.response,
        respondedAt: row.reply_date,
        status,
        templateUsed: row.template_used,
        subject: row.subject,
        message: hasMessage ? row.message.split('\n')[0].trim() : null,
        product: row.product,
        hasReply: hasMessage,
        isInterested,
        isNotInterested,
      };
    });

    const multipleProducts = batchInfo[0].multiple_products;
    const mainProduct =
      multipleProducts === 1 ? 'General Products' : batchInfo[0].product;

    res.json({
      success: true,
      data: {
        id: batchInfo[0].id,
        product: mainProduct,
        multiple_products: multipleProducts,
        date: batchInfo[0].sent_at,
        companies: companies,
        counts: {
          total: counts.total || 0,
          replied: counts.replied || 0,
          interested: counts.interested || 0,
          notInterested: counts.not_interested || 0,
          emailSent: counts.emailSent || 0,
        },
      },
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(totalCompanies / limitNum),
        totalItems: totalCompanies,
        itemsPerPage: limitNum,
      },
    });
  } catch (err) {
    console.error('GET /history/:id error:', err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

/* ─────────────────────────────────────────────
   GET /history/:id/replies — replies for a batch
───────────────────────────────────────────── */
router.get('/history/:id/replies', async (req, res) => {
  const pool = req.app.get('pool');
  try {
    const { id } = req.params;

    const [replies] = await pool.query(
      `
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
        ON c.batch_id = r.batch_id AND c.email = r.from_email
      WHERE r.batch_id = ?
      ORDER BY r.reply_date DESC
    `,
      [id]
    );

    res.json({ batchId: id, total: replies.length, replies });
  } catch (err) {
    console.error('GET /history/:id/replies error:', err);
    res.status(500).json({ error: err.message });
  }
});


router.get('/api/admin/history', async (req, res) => {
  const pool = req.app.get('pool');
  console.log('GET /api/admin/history called');

  try {
    const [results] = await pool.query(`
      SELECT 
        id,
        seller_id,
        company_name,
        country,
        contact_name,
        email,
        from_email,
        to_email,
        subject,
        message,
        product_name,
        reply_date,
        sent_at,
        status,
        template_used,
        response,
        responded_at,
        batch_id,
        buyer_id,
        multiple_products,
        template_id,
        DATE_FORMAT(sent_at, '%Y-%m-%d %H:%i:%s') as sent_at_formatted,
        DATE_FORMAT(reply_date, '%Y-%m-%d %H:%i:%s') as reply_date_formatted,
        DATE_FORMAT(responded_at, '%Y-%m-%d %H:%i:%s') as responded_at_formatted,
        CASE 
          WHEN message IS NOT NULL AND message != '' AND response = 'interested' THEN 'Replied, Interested'
          WHEN message IS NOT NULL AND message != '' AND response = 'not_interested' THEN 'Replied, Not Interested'
          WHEN message IS NOT NULL AND message != '' THEN 'Replied'
          WHEN response = 'interested' THEN 'Interested'
          WHEN response = 'not_interested' THEN 'Not Interested'
          WHEN status = 'sent' THEN 'Sent'
          ELSE 'Unknown'
        END as display_status,
        CASE WHEN message IS NOT NULL AND message != '' THEN 1 ELSE 0 END as has_reply,
        CASE WHEN response = 'interested' THEN 1 ELSE 0 END as is_interested,
        CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END as is_not_interested
      FROM email_history_companies
      ORDER BY sent_at DESC, id DESC
    `);

    console.log(`Found ${results.length} total records for admin`);

    if (results.length === 0) {
      return res.json({
        success: true,
        message: 'No history records found',
        data: [],
        total: 0,
        summary: {
          total_records: 0,
          total_sellers: 0,
          total_batches: 0,
          total_buyers: 0,
          total_sent: 0,
          total_replied: 0,
          total_interested: 0,
          total_not_interested: 0,
        },
      });
    }

    const [stats] = await pool.query(`
      SELECT 
        COUNT(*) as total_records,
        COUNT(DISTINCT seller_id) as total_sellers,
        COUNT(DISTINCT batch_id) as total_batches,
        COUNT(DISTINCT buyer_id) as total_buyers,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as total_sent,
        SUM(CASE WHEN message IS NOT NULL AND message != '' THEN 1 ELSE 0 END) as total_replied,
        SUM(CASE WHEN response = 'interested' THEN 1 ELSE 0 END) as total_interested,
        SUM(CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END) as total_not_interested
      FROM email_history_companies
    `);

    const [sellerBreakdown] = await pool.query(`
      SELECT 
        seller_id,
        COUNT(*) as total_records,
        COUNT(DISTINCT batch_id) as total_batches,
        COUNT(DISTINCT buyer_id) as total_buyers,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent_count,
        SUM(CASE WHEN message IS NOT NULL AND message != '' THEN 1 ELSE 0 END) as replied_count,
        SUM(CASE WHEN response = 'interested' THEN 1 ELSE 0 END) as interested_count,
        SUM(CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END) as not_interested_count
      FROM email_history_companies
      GROUP BY seller_id
      ORDER BY total_records DESC
    `);

    const [batchBreakdown] = await pool.query(`
      SELECT 
        batch_id,
        seller_id,
        COUNT(*) as total_records,
        MAX(product_name) as product_name,
        MIN(sent_at) as first_sent,
        MAX(sent_at) as last_sent,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent_count,
        SUM(CASE WHEN message IS NOT NULL AND message != '' THEN 1 ELSE 0 END) as replied_count,
        SUM(CASE WHEN response = 'interested' THEN 1 ELSE 0 END) as interested_count,
        SUM(CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END) as not_interested_count
      FROM email_history_companies
      GROUP BY batch_id, seller_id
      ORDER BY last_sent DESC
    `);

    res.json({
      success: true,
      total: results.length,
      data: results,
      summary: {
        total_records: stats[0]?.total_records || 0,
        total_sellers: stats[0]?.total_sellers || 0,
        total_batches: stats[0]?.total_batches || 0,
        total_buyers: stats[0]?.total_buyers || 0,
        total_sent: stats[0]?.total_sent || 0,
        total_replied: stats[0]?.total_replied || 0,
        total_interested: stats[0]?.total_interested || 0,
        total_not_interested: stats[0]?.total_not_interested || 0,
      },
      seller_breakdown: sellerBreakdown,
      batch_breakdown: batchBreakdown,
    });
  } catch (err) {
    console.error('GET /api/admin/history error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/* ─────────────────────────────────────────────
   GET /api/admin/history/:id — records for one buyer
───────────────────────────────────────────── */
router.get('/api/admin/history/:id', async (req, res) => {
  const pool = req.app.get('pool');
  const { id } = req.params;

  console.log('GET /api/admin/history/:id called with id:', id);

  try {
    let [results] = await pool.query(
      `
      SELECT 
        id, buyer_id, batch_id, seller_id, company_name, country, contact_name,
        from_email, to_email, subject, message, product_name, sent_at, reply_date,
        responded_at, status, template_used, response,
        DATE_FORMAT(sent_at, '%Y-%m-%d %H:%i:%s') as sent_at_formatted,
        DATE_FORMAT(reply_date, '%Y-%m-%d %H:%i:%s') as reply_date_formatted,
        DATE_FORMAT(responded_at, '%Y-%m-%d %H:%i:%s') as responded_at_formatted,
        CASE 
          WHEN message IS NOT NULL AND message != '' AND response = 'interested' THEN 'Replied, Interested'
          WHEN message IS NOT NULL AND message != '' AND response = 'not_interested' THEN 'Replied, Not Interested'
          WHEN message IS NOT NULL AND message != '' THEN 'Replied'
          WHEN response = 'interested' THEN 'Interested'
          WHEN response = 'not_interested' THEN 'Not Interested'
          WHEN status = 'sent' THEN 'Sent'
          ELSE 'Unknown'
        END as display_status
      FROM email_history_companies
      WHERE buyer_id = ?
      ORDER BY sent_at DESC, id DESC
    `,
      [id]
    );

    if (results.length === 0) {
      [results] = await pool.query(
        `
        SELECT 
          id, buyer_id, batch_id, seller_id, company_name, country, contact_name,
          from_email, to_email, subject, message, product_name, sent_at, reply_date,
          responded_at, status, template_used, response,
          DATE_FORMAT(sent_at, '%Y-%m-%d %H:%i:%s') as sent_at_formatted,
          DATE_FORMAT(reply_date, '%Y-%m-%d %H:%i:%s') as reply_date_formatted,
          DATE_FORMAT(responded_at, '%Y-%m-%d %H:%i:%s') as responded_at_formatted,
          CASE 
            WHEN message IS NOT NULL AND message != '' AND response = 'interested' THEN 'Replied, Interested'
            WHEN message IS NOT NULL AND message != '' AND response = 'not_interested' THEN 'Replied, Not Interested'
            WHEN message IS NOT NULL AND message != '' THEN 'Replied'
            WHEN response = 'interested' THEN 'Interested'
            WHEN response = 'not_interested' THEN 'Not Interested'
            WHEN status = 'sent' THEN 'Sent'
            ELSE 'Unknown'
          END as display_status
        FROM email_history_companies
        WHERE id = ?
        ORDER BY sent_at DESC, id DESC
      `,
        [id]
      );
    }

    if (results.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No records found for this buyer',
      });
    }

    const cleanedResults = results.map((row) => {
      let cleanedMessage = row.message;

      if (cleanedMessage) {
        const patterns = [
          /\nOn\s+.+\s+wrote:\s*\n/i,
          /\n-----Original Message-----\s*\n/i,
          /\n>+\s*.+\n/i,
          /\n\n\n.*\nOn\s+/s,
          /\n\n.*wrote:\s*\n/s,
        ];

        let replyEndIndex = -1;
        for (const pattern of patterns) {
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
          .split('\n')
          .filter((line) => !line.trim().startsWith('>'))
          .join('\n')
          .trim();

        cleanedMessage = cleanedMessage
          .replace(/\\u003C/g, '<')
          .replace(/\\u003E/g, '>')
          .replace(/\[[^\]]*\]/g, '')
          .replace(/https?:\/\/[^\s]+/g, '')
          .trim();
      }

      let cleanedSubject = row.subject;
      if (cleanedSubject) {
        cleanedSubject = cleanedSubject.replace(/\s*\[BATCH:[^\]]+\]/g, '');
        cleanedSubject = cleanedSubject.replace(/^Re:\s*/i, '');
        cleanedSubject = cleanedSubject.trim();
      }

      return {
        ...row,
        message: cleanedMessage,
        subject: cleanedSubject,
      };
    });

    const firstRecord = results[0];
    const buyerInfo = {
      buyer_id: firstRecord.buyer_id,
      company_name: firstRecord.company_name,
      country: firstRecord.country,
      product_name: firstRecord.product_name,
      contact_name: firstRecord.contact_name,
      email: firstRecord.from_email || firstRecord.email,
      all_emails: firstRecord.from_email || '',
      all_contacts: firstRecord.contact_name || '',
      seller_id: firstRecord.seller_id,
    };

    const summary = {
      total: results.length,
      sent: results.filter((r) => r.status === 'sent' || r.display_status === 'Sent').length,
      replied: results.filter((r) => r.message && r.message.trim() !== '').length,
      interested: results.filter((r) => r.response === 'interested').length,
      not_interested: results.filter((r) => r.response === 'not_interested').length,
      last_activity: results[0]?.sent_at || null,
    };

    res.json({
      success: true,
      data: cleanedResults,
      buyer_info: buyerInfo,
      summary: summary,
    });
  } catch (err) {
    console.error('GET /api/admin/history/:id error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

module.exports = router;