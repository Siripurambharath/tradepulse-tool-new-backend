// routes/buyerRoutes.js
const express = require('express');
const router = express.Router();

// Get the pool from app settings
let pool;

// Middleware to get pool from app
router.use((req, res, next) => {
  pool = req.app.get('pool');
  if (!pool) {
    return res.status(500).json({ 
      success: false, 
      message: 'Database connection not available' 
    });
  }
  next();
});

/**
 * POST /api/buyers
 * Add a new buyer with contacts and emails
 */
router.post('/api/buyers', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const {
      product,
      hsn_code,
      country,
      company_name,
      website,
      address,
      details,
      suggested_keywords,
      hsn_descriptions,
      confidence_level,
      reason,
      classification_notes,
      manual_verification,
      buyer_date,
      contacts,
      emails
    } = req.body;

    // Validate required fields
    if (!product || !hsn_code || !country || !company_name) {
      return res.status(400).json({
        success: false,
        message: 'Product, HSN Code, Country, and Company Name are required'
      });
    }

    // Validate contacts and emails arrays
    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one contact number is required'
      });
    }

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one email address is required'
      });
    }

    // Start transaction
    await connection.beginTransaction();

    // 1. Insert into buyers table
    const buyerQuery = `
      INSERT INTO buyers (
        product,
        hsn_code,
        country,
        company_name,
        website,
        address,
        details,
        suggested_keywords,
        hsn_descriptions,
        confidence_level,
        reason,
        classification_notes,
        manual_verification,
        buyer_date,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `;

    const [buyerResult] = await connection.execute(buyerQuery, [
      product,
      hsn_code,
      country,
      company_name,
      website || null,
      address || null,
      details || null,
      suggested_keywords || null,
      hsn_descriptions || null,
      confidence_level || null,
      reason || null,
      classification_notes || null,
      manual_verification || null,
      buyer_date || null
    ]);

    const buyerId = buyerResult.insertId;

    // 2. Insert contacts
    if (contacts && contacts.length > 0) {
      const contactQuery = `
        INSERT INTO buyer_contacts (buyer_id, contact_number) 
        VALUES (?, ?)
      `;
      
      for (const contact of contacts) {
        if (contact.contact_number && contact.contact_number.trim()) {
          await connection.execute(contactQuery, [
            buyerId,
            contact.contact_number.trim()
          ]);
        }
      }
    }

    // 3. Insert emails
    if (emails && emails.length > 0) {
      const emailQuery = `
        INSERT INTO buyer_emails (buyer_id, email) 
        VALUES (?, ?)
      `;
      
      for (const email of emails) {
        if (email.email && email.email.trim()) {
          await connection.execute(emailQuery, [
            buyerId,
            email.email.trim()
          ]);
        }
      }
    }

    // Commit transaction
    await connection.commit();

    // Get the inserted buyer with contacts and emails
    const [buyerData] = await connection.query(`
      SELECT 
        b.id,
        b.product,
        b.hsn_code,
        b.country,
        b.company_name,
        b.website,
        b.address,
        b.details,
        b.suggested_keywords,
        b.hsn_descriptions,
        b.confidence_level,
        b.reason,
        b.classification_notes,
        b.manual_verification,
        b.buyer_date,
        b.created_at
      FROM buyers b
      WHERE b.id = ?
    `, [buyerId]);

    // Get contacts
    const [contactData] = await connection.query(
      'SELECT id, contact_number FROM buyer_contacts WHERE buyer_id = ?',
      [buyerId]
    );

    // Get emails
    const [emailData] = await connection.query(
      'SELECT id, email FROM buyer_emails WHERE buyer_id = ?',
      [buyerId]
    );

    res.status(201).json({
      success: true,
      message: 'Buyer added successfully',
      data: {
        ...buyerData[0],
        contacts: contactData,
        emails: emailData
      }
    });

  } catch (error) {
    // Rollback transaction on error
    await connection.rollback();
    
    console.error('Error adding buyer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add buyer',
      error: error.message
    });
  } finally {
    connection.release();
  }
});

/**
 * GET /api/buyers
 * Get all buyers with pagination and search
 */
router.get('/api/buyers', async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        b.id,
        b.product,
        b.hsn_code,
        b.country,
        b.company_name,
        b.website,
        b.address,
        b.details,
        b.suggested_keywords,
        b.hsn_descriptions,
        b.confidence_level,
        b.reason,
        b.classification_notes,
        b.manual_verification,
        b.buyer_date,
        b.created_at
      FROM buyers b
    `;

    let countQuery = 'SELECT COUNT(*) as total FROM buyers b';
    const params = [];
    const countParams = [];

    if (search) {
      query += ` WHERE b.product LIKE ? OR b.company_name LIKE ? OR b.country LIKE ?`;
      countQuery += ` WHERE b.product LIKE ? OR b.company_name LIKE ? OR b.country LIKE ?`;
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
      countParams.push(searchTerm, searchTerm, searchTerm);
    }

    query += ` ORDER BY b.created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const [buyers] = await pool.query(query, params);
    const [totalResult] = await pool.query(countQuery, countParams);

    // Get contacts and emails for each buyer
    for (let buyer of buyers) {
      const [contacts] = await pool.query(
        'SELECT id, contact_number FROM buyer_contacts WHERE buyer_id = ?',
        [buyer.id]
      );
      const [emails] = await pool.query(
        'SELECT id, email FROM buyer_emails WHERE buyer_id = ?',
        [buyer.id]
      );
      buyer.contacts = contacts;
      buyer.emails = emails;
    }

    res.json({
      success: true,
      data: buyers,
      pagination: {
        total: totalResult[0].total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(totalResult[0].total / limit)
      }
    });

  } catch (error) {
    console.error('Error fetching buyers:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch buyers',
      error: error.message
    });
  }
});

/**
 * GET /api/buyers/:id
 * Get a single buyer with contacts and emails
 */
router.get('/api/buyers/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [buyerData] = await pool.query(`
      SELECT 
        b.id,
        b.product,
        b.hsn_code,
        b.country,
        b.company_name,
        b.website,
        b.address,
        b.details,
        b.suggested_keywords,
        b.hsn_descriptions,
        b.confidence_level,
        b.reason,
        b.classification_notes,
        b.manual_verification,
        b.buyer_date,
        b.created_at
      FROM buyers b
      WHERE b.id = ?
    `, [id]);

    if (buyerData.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Buyer not found'
      });
    }

    // Get contacts
    const [contacts] = await pool.query(
      'SELECT id, contact_number FROM buyer_contacts WHERE buyer_id = ?',
      [id]
    );

    // Get emails
    const [emails] = await pool.query(
      'SELECT id, email FROM buyer_emails WHERE buyer_id = ?',
      [id]
    );

    res.json({
      success: true,
      data: {
        ...buyerData[0],
        contacts: contacts,
        emails: emails
      }
    });

  } catch (error) {
    console.error('Error fetching buyer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch buyer',
      error: error.message
    });
  }
});

/**
 * PUT /api/buyers/:id
 * Update a buyer with contacts and emails
 */
router.put('/api/buyers/:id', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const { id } = req.params;
    const {
      product,
      hsn_code,
      country,
      company_name,
      website,
      address,
      details,
      suggested_keywords,
      hsn_descriptions,
      confidence_level,
      reason,
      classification_notes,
      manual_verification,
      buyer_date,
      contacts,
      emails
    } = req.body;

    // Validate required fields
    if (!product || !hsn_code || !country || !company_name) {
      return res.status(400).json({
        success: false,
        message: 'Product, HSN Code, Country, and Company Name are required'
      });
    }

    // Start transaction
    await connection.beginTransaction();

    // 1. Update buyers table
    const buyerQuery = `
      UPDATE buyers SET
        product = ?,
        hsn_code = ?,
        country = ?,
        company_name = ?,
        website = ?,
        address = ?,
        details = ?,
        suggested_keywords = ?,
        hsn_descriptions = ?,
        confidence_level = ?,
        reason = ?,
        classification_notes = ?,
        manual_verification = ?,
        buyer_date = ?
      WHERE id = ?
    `;

    await connection.execute(buyerQuery, [
      product,
      hsn_code,
      country,
      company_name,
      website || null,
      address || null,
      details || null,
      suggested_keywords || null,
      hsn_descriptions || null,
      confidence_level || null,
      reason || null,
      classification_notes || null,
      manual_verification || null,
      buyer_date || null,
      id
    ]);

    // 2. Delete existing contacts and emails
    await connection.execute('DELETE FROM buyer_contacts WHERE buyer_id = ?', [id]);
    await connection.execute('DELETE FROM buyer_emails WHERE buyer_id = ?', [id]);

    // 3. Insert new contacts
    if (contacts && contacts.length > 0) {
      const contactQuery = `
        INSERT INTO buyer_contacts (buyer_id, contact_number) 
        VALUES (?, ?)
      `;
      
      for (const contact of contacts) {
        if (contact.contact_number && contact.contact_number.trim()) {
          await connection.execute(contactQuery, [
            id,
            contact.contact_number.trim()
          ]);
        }
      }
    }

    // 4. Insert new emails
    if (emails && emails.length > 0) {
      const emailQuery = `
        INSERT INTO buyer_emails (buyer_id, email) 
        VALUES (?, ?)
      `;
      
      for (const email of emails) {
        if (email.email && email.email.trim()) {
          await connection.execute(emailQuery, [
            id,
            email.email.trim()
          ]);
        }
      }
    }

    // Commit transaction
    await connection.commit();

    // Get the updated buyer with contacts and emails
    const [buyerData] = await connection.query(`
      SELECT 
        b.id,
        b.product,
        b.hsn_code,
        b.country,
        b.company_name,
        b.website,
        b.address,
        b.details,
        b.suggested_keywords,
        b.hsn_descriptions,
        b.confidence_level,
        b.reason,
        b.classification_notes,
        b.manual_verification,
        b.buyer_date,
        b.created_at
      FROM buyers b
      WHERE b.id = ?
    `, [id]);

    // Get contacts
    const [contactData] = await connection.query(
      'SELECT id, contact_number FROM buyer_contacts WHERE buyer_id = ?',
      [id]
    );

    // Get emails
    const [emailData] = await connection.query(
      'SELECT id, email FROM buyer_emails WHERE buyer_id = ?',
      [id]
    );

    res.json({
      success: true,
      message: 'Buyer updated successfully',
      data: {
        ...buyerData[0],
        contacts: contactData,
        emails: emailData
      }
    });

  } catch (error) {
    // Rollback transaction on error
    await connection.rollback();
    
    console.error('Error updating buyer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update buyer',
      error: error.message
    });
  } finally {
    connection.release();
  }
});

/**
 * DELETE /api/buyers/:id
 * Delete a buyer and its associated contacts and emails
 */
router.delete('/api/buyers/:id', async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const { id } = req.params;

    // Start transaction
    await connection.beginTransaction();

    // Delete contacts
    await connection.execute('DELETE FROM buyer_contacts WHERE buyer_id = ?', [id]);
    
    // Delete emails
    await connection.execute('DELETE FROM buyer_emails WHERE buyer_id = ?', [id]);
    
    // Delete buyer
    const [result] = await connection.execute('DELETE FROM buyers WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Buyer not found'
      });
    }

    // Commit transaction
    await connection.commit();

    res.json({
      success: true,
      message: 'Buyer deleted successfully'
    });

  } catch (error) {
    // Rollback transaction on error
    await connection.rollback();
    
    console.error('Error deleting buyer:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete buyer',
      error: error.message
    });
  } finally {
    connection.release();
  }
});

/**
 * GET /api/buyers/stats
 * Get buyer statistics
 */
router.get('/api/buyers/stats', async (req, res) => {
  try {
    const [totalBuyers] = await pool.query('SELECT COUNT(*) as total FROM buyers');
    
    const [countryStats] = await pool.query(`
      SELECT country, COUNT(*) as count 
      FROM buyers 
      WHERE country IS NOT NULL AND country != ''
      GROUP BY country 
      ORDER BY count DESC
      LIMIT 10
    `);
    
    const [productStats] = await pool.query(`
      SELECT product, COUNT(*) as count 
      FROM buyers 
      WHERE product IS NOT NULL AND product != ''
      GROUP BY product 
      ORDER BY count DESC
      LIMIT 10
    `);

    const [contactCount] = await pool.query('SELECT COUNT(*) as total FROM buyer_contacts');
    const [emailCount] = await pool.query('SELECT COUNT(*) as total FROM buyer_emails');

    res.json({
      success: true,
      data: {
        totalBuyers: totalBuyers[0].total,
        totalContacts: contactCount[0].total,
        totalEmails: emailCount[0].total,
        byCountry: countryStats,
        topProducts: productStats
      }
    });

  } catch (error) {
    console.error('Error fetching buyer stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch buyer statistics',
      error: error.message
    });
  }
});

module.exports = router;