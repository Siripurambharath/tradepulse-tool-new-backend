// routes/trackingRoutes.js
const express = require('express');
const router = express.Router();

// Get tracking counts
router.get('/api/tracking/counts', async (req, res) => {
  const pool = req.app.get('pool');
  const { seller_id } = req.query;

  if (!seller_id) {
    return res.status(400).json({ success: false, error: 'seller_id is required' });
  }

  try {
   
    const [sentCount] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as count
      FROM email_history_companies
      WHERE status = 'sent'
        AND buyer_id IS NOT NULL
        AND seller_id = ?
    `, [seller_id]);

    const [repliedCount] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as count
      FROM email_history_companies
      WHERE message IS NOT NULL 
        AND message != ''
        AND reply_date IS NOT NULL
        AND buyer_id IS NOT NULL
        AND seller_id = ?
    `, [seller_id]);

    const [interestedCount] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as count
      FROM email_history_companies
      WHERE response = 'interested'
        AND buyer_id IS NOT NULL
        AND seller_id = ?
    `, [seller_id]);

    const [notInterestedCount] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as count
      FROM email_history_companies
      WHERE response = 'not_interested'
        AND buyer_id IS NOT NULL
        AND seller_id = ?
    `, [seller_id]);

    const [notContactedCount] = await pool.query(`
      SELECT COUNT(*) as count
      FROM buyers b
      WHERE NOT EXISTS (
        SELECT 1 FROM email_history_companies ehc 
        WHERE ehc.buyer_id = b.id AND ehc.seller_id = ?
      )
    `, [seller_id]);

    const [totalContacted] = await pool.query(`
      SELECT COUNT(DISTINCT buyer_id) as count
      FROM email_history_companies
      WHERE buyer_id IS NOT NULL
        AND seller_id = ?
    `, [seller_id]);

    res.json({
      success: true,
      data: {
        sent: sentCount[0].count,
        replied: repliedCount[0].count,
        interested: interestedCount[0].count,
        not_interested: notInterestedCount[0].count,
        not_contacted: notContactedCount[0].count
      },
      total: {
        all: totalContacted[0].count + notContactedCount[0].count
      }
    });

  } catch (err) {
    console.error('GET /api/tracking/counts error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all tracking data
router.get('/api/tracking/all', async (req, res) => {
  const pool = req.app.get('pool');
  const { seller_id } = req.query;

  if (!seller_id) {
    return res.status(400).json({ success: false, error: 'seller_id is required' });
  }

  try {
    const [sentEmails] = await pool.query(`
      SELECT 
        buyer_id,
        MAX(company_name) as company_name,
        MAX(country) as country,
        MAX(contact_name) as contact_name,
        MAX(email) as email,
        MAX(template_used) as template_used,
        MAX(product_name) as product_name,
        COUNT(*) as interaction_count,
        MAX(sent_at) as last_interaction,
        'sent' as type,
        'sent' as current_status
      FROM email_history_companies
      WHERE status = 'sent'
        AND seller_id = ?
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
    `, [seller_id]);

    const [repliedEmails] = await pool.query(`
      SELECT 
        buyer_id,
        MAX(company_name) as company_name,
        MAX(country) as country,
        MAX(contact_name) as contact_name,
        MAX(email) as email,
        MAX(product_name) as product_name,
        COUNT(*) as interaction_count,
        MAX(reply_date) as last_interaction,
        'replied' as type,
        'replied' as current_status
      FROM email_history_companies
      WHERE message IS NOT NULL 
        AND message != ''
        AND reply_date IS NOT NULL
        AND seller_id = ?
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
    `, [seller_id]);

    const [interestedEmails] = await pool.query(`
      SELECT 
        buyer_id,
        MAX(company_name) as company_name,
        MAX(country) as country,
        MAX(contact_name) as contact_name,
        MAX(email) as email,
        MAX(product_name) as product_name,
        COUNT(*) as interaction_count,
        MAX(responded_at) as last_interaction,
        'interested' as type,
        'interested' as current_status
      FROM email_history_companies
      WHERE response = 'interested'
        AND seller_id = ?
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
    `, [seller_id]);

    const [notInterestedEmails] = await pool.query(`
      SELECT 
        buyer_id,
        MAX(company_name) as company_name,
        MAX(country) as country,
        MAX(contact_name) as contact_name,
        MAX(email) as email,
        MAX(product_name) as product_name,
        COUNT(*) as interaction_count,
        MAX(responded_at) as last_interaction,
        'not_interested' as type,
        'not_interested' as current_status
      FROM email_history_companies
      WHERE response = 'not_interested'
        AND seller_id = ?
      GROUP BY buyer_id
      ORDER BY last_interaction DESC
    `, [seller_id]);

    const [notContacted] = await pool.query(`
      SELECT DISTINCT
        b.id as buyer_id,
        b.company_name,
        b.country,
        b.product as product_name,
        b.hsn_code,
        GROUP_CONCAT(DISTINCT be.email SEPARATOR ', ') as email,
        GROUP_CONCAT(DISTINCT bc.contact_number SEPARATOR ', ') as contact_name,
        0 as interaction_count,
        NULL as last_interaction,
        'not_contacted' as type,
        'not_contacted' as current_status
      FROM buyers b
      LEFT JOIN buyer_emails be ON b.id = be.buyer_id
      LEFT JOIN buyer_contacts bc ON b.id = bc.buyer_id
      WHERE NOT EXISTS (
        SELECT 1 FROM email_history_companies ehc 
        WHERE ehc.buyer_id = b.id AND ehc.seller_id = ?
      )
      GROUP BY b.id
      ORDER BY b.company_name
    `, [seller_id]);

    const [detailedCounts] = await pool.query(`
      SELECT 
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as total_sent,
        SUM(CASE WHEN message IS NOT NULL AND message != '' AND reply_date IS NOT NULL THEN 1 ELSE 0 END) as total_replied,
        SUM(CASE WHEN response = 'interested' THEN 1 ELSE 0 END) as total_interested,
        SUM(CASE WHEN response = 'not_interested' THEN 1 ELSE 0 END) as total_not_interested
      FROM email_history_companies
      WHERE seller_id = ?
    `, [seller_id]);

    const [uniqueBuyerCounts] = await pool.query(`
      SELECT 
        COUNT(DISTINCT CASE WHEN status = 'sent' THEN buyer_id END) as unique_sent_buyers,
        COUNT(DISTINCT CASE WHEN message IS NOT NULL AND message != '' AND reply_date IS NOT NULL THEN buyer_id END) as unique_replied_buyers,
        COUNT(DISTINCT CASE WHEN response = 'interested' THEN buyer_id END) as unique_interested_buyers,
        COUNT(DISTINCT CASE WHEN response = 'not_interested' THEN buyer_id END) as unique_not_interested_buyers
      FROM email_history_companies
      WHERE seller_id = ?
    `, [seller_id]);

    const [notContactedCount] = await pool.query(`
      SELECT COUNT(DISTINCT b.id) as count
      FROM buyers b
      WHERE NOT EXISTS (
        SELECT 1 FROM email_history_companies ehc 
        WHERE ehc.buyer_id = b.id AND ehc.seller_id = ?
      )
    `, [seller_id]);

    res.json({
      success: true,
      data: {
        sent: sentEmails,
        replied: repliedEmails,
        interested: interestedEmails,
        not_interested: notInterestedEmails,
        notContacted: notContacted
      },
      counts: {
        totalSent: detailedCounts[0]?.total_sent || 0,
        totalReplied: detailedCounts[0]?.total_replied || 0,
        totalInterested: detailedCounts[0]?.total_interested || 0,
        totalNotInterested: detailedCounts[0]?.total_not_interested || 0,
        totalNotContacted: notContactedCount[0]?.count || 0,
        
        uniqueBuyers: {
          sent: uniqueBuyerCounts[0]?.unique_sent_buyers || 0,
          replied: uniqueBuyerCounts[0]?.unique_replied_buyers || 0,
          interested: uniqueBuyerCounts[0]?.unique_interested_buyers || 0,
          not_interested: uniqueBuyerCounts[0]?.unique_not_interested_buyers || 0,
          not_contacted: notContactedCount[0]?.count || 0
        }
      }
    });

  } catch (err) {
    console.error('GET /api/tracking/all error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get tracking data for a specific buyer
router.get('/api/tracking/buyer/:id', async (req, res) => {
  const pool = req.app.get('pool');
  const buyerId = req.params.id;
  const sellerId = req.query.sellerId;

  try {
    if (!sellerId) {
      return res.status(400).json({ 
        success: false, 
        message: 'sellerId is required' 
      });
    }

    const [buyerInfoResult] = await pool.query(`
      SELECT 
        b.id as buyer_id,
        b.company_name,
        b.country,
        b.product,
        GROUP_CONCAT(DISTINCT be.email SEPARATOR ', ') as emails,
        GROUP_CONCAT(DISTINCT bc.contact_number SEPARATOR ', ') as contacts
      FROM buyers b
      LEFT JOIN buyer_emails be ON b.id = be.buyer_id
      LEFT JOIN buyer_contacts bc ON b.id = bc.buyer_id
      WHERE b.id = ?
      GROUP BY b.id
    `, [buyerId]);

    if (buyerInfoResult.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Buyer not found' 
      });
    }

    const buyerInfo = buyerInfoResult[0];

    const [communications] = await pool.query(`
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
        'email' as record_type
      FROM email_history_companies
      WHERE buyer_id = ? AND seller_id = ?
      ORDER BY COALESCE(sent_at, reply_date, responded_at) DESC
    `, [buyerId, sellerId]);

    const processedCommunications = communications.map(comm => {
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
        date: comm.sent_at || comm.reply_date || comm.responded_at
      };
    });

    const summary = {
      total: processedCommunications.length,
      sent: processedCommunications.filter(c => c.display_status === 'Sent').length,
      replied: processedCommunications.filter(c => c.display_status === 'Replied').length,
      interested: processedCommunications.filter(c => c.display_status === 'Interested').length,
      not_interested: processedCommunications.filter(c => c.display_status === 'Not Interested').length,
      last_activity: processedCommunications[0]?.date || null
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
        seller_id: sellerId
      },
      summary: summary
    });

  } catch (err) {
    console.error('GET /api/tracking/buyer/:id error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

module.exports = router;