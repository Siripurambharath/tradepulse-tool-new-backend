const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");
const pool = require("../db"); // Import the pool directly

/* ===============================
   PATH CONFIG
================================ */
const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");
const BUYER_DIR = path.join(UPLOADS_ROOT, "buyers");

[UPLOADS_ROOT, BUYER_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

/* ===============================
   MULTER (EXCEL UPLOAD ONLY)
================================ */
const excelStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_ROOT),
  filename: (req, file, cb) =>
    cb(null, `buyer-excel-${Date.now()}${path.extname(file.originalname)}`),
});

const uploadExcel = multer({ 
  storage: excelStorage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

/* ===============================
   DOWNLOAD TEMPLATE
================================ */
router.get("/api/buyers/bulk/download-template", (req, res) => {
  try {
    const templateData = [
      {
        product: "Spices",
        hsn_code: "9103010",
        country: "China",
        company_name: "Guangxi BaiXiangHui Import & Export Trading Co., Ltd",
        website: "https://example.com",
        buyer_date: "2025-11-29",
        address: "",
        details: "",
        suggested_keywords: "",
        hsn_descriptions: "",
        confidence_level: "Medium",
        reason: "",
        classification_notes: "",
        manual_verification: "Pending",
        contact_numbers: "+916301402298",
        emails: "example@email.com",
      },
      {
        product: "Bedsheet",
        hsn_code: "6304 1940",
        country: "South Africa",
        company_name: "HUL International Pty Ltd.",
        website: "https://example2.com",
        buyer_date: "2025-11-29",
        address: "",
        details: "",
        suggested_keywords: "",
        hsn_descriptions: "",
        confidence_level: "High",
        reason: "",
        classification_notes: "",
        manual_verification: "Yes",
        contact_numbers: "+919160188248, +919290812425",
        emails: "contact@example.com, info@example.com",
      },
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(templateData);

    // Set column widths
    ws['!cols'] = [
      { wch: 20 }, // product
      { wch: 15 }, // hsn_code
      { wch: 15 }, // country
      { wch: 40 }, // company_name
      { wch: 25 }, // website
      { wch: 15 }, // buyer_date
      { wch: 30 }, // address
      { wch: 40 }, // details
      { wch: 30 }, // suggested_keywords
      { wch: 30 }, // hsn_descriptions
      { wch: 12 }, // confidence_level
      { wch: 40 }, // reason
      { wch: 40 }, // classification_notes
      { wch: 15 }, // manual_verification
      { wch: 30 }, // contact_numbers
      { wch: 30 }, // emails
    ];

    XLSX.utils.book_append_sheet(wb, ws, "Template");

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="buyer_bulk_template.xlsx"'
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.send(buf);
  } catch (error) {
    console.error("❌ Template download error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate template"
    });
  }
});

/* ===============================
   CHECK DUPLICATE FUNCTION
================================ */
const checkDuplicate = async (connection, product, company_name, contactNumbers, emails) => {
  try {
    // Check if product and company_name already exist
    const [existingBuyers] = await connection.query(
      `SELECT id FROM buyers WHERE product = ? AND company_name = ?`,
      [product, company_name]
    );

    if (existingBuyers.length === 0) {
      return null; // No duplicate found
    }

    const buyerId = existingBuyers[0].id;
    let hasMatchingContact = false;
    let hasMatchingEmail = false;

    // Check if any contact number matches
    if (contactNumbers.length > 0) {
      const [existingContacts] = await connection.query(
        `SELECT contact_number FROM buyer_contacts WHERE buyer_id = ? AND contact_number IN (?)`,
        [buyerId, contactNumbers]
      );
      if (existingContacts.length > 0) {
        hasMatchingContact = true;
      }
    }

    // Check if any email matches
    if (emails.length > 0) {
      const [existingEmails] = await connection.query(
        `SELECT email FROM buyer_emails WHERE buyer_id = ? AND email IN (?)`,
        [buyerId, emails]
      );
      if (existingEmails.length > 0) {
        hasMatchingEmail = true;
      }
    }

    // If both product/company match and at least one contact or email matches
    if (hasMatchingContact || hasMatchingEmail) {
      return {
        exists: true,
        buyerId: buyerId,
        message: `Duplicate found: Product "${product}" with Company "${company_name}" already exists with matching contact/email`
      };
    }

    return null;
  } catch (error) {
    console.error("❌ Error checking duplicate:", error);
    throw error;
  }
};

/* ===============================
   BULK UPLOAD BUYERS
================================ */
router.post(
  "/api/buyers/bulk-upload",
  uploadExcel.single("excelFile"),
  async (req, res) => {
    let connection;
    let duplicateEntries = [];
    let insertedCount = 0;
    let skippedCount = 0;
    
    try {
      // Get connection from pool
      connection = await pool.getConnection();
      await connection.beginTransaction();

      if (!req.file) {
        return res.status(400).json({ 
          success: false,
          message: "No file uploaded" 
        });
      }

      const workbook = XLSX.readFile(req.file.path);
      const sheet = workbook.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheet]);

      if (rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Excel file is empty"
        });
      }

      for (const row of rows) {
        // Extract fields
        const product = String(row.product || "").trim();
        const hsn_code = String(row.hsn_code || "").trim();
        const country = String(row.country || "").trim();
        const company_name = String(row.company_name || "").trim();
        const website = String(row.website || "").trim();
        const buyer_date = row.buyer_date || null;
        const address = String(row.address || "").trim();
        const details = String(row.details || "").trim();
        const suggested_keywords = String(row.suggested_keywords || "").trim();
        const hsn_descriptions = String(row.hsn_descriptions || "").trim();
        const confidence_level = String(row.confidence_level || "Medium").trim();
        const reason = String(row.reason || "").trim();
        const classification_notes = String(row.classification_notes || "").trim();
        const manual_verification = String(row.manual_verification || "Pending").trim();

        // Extract contacts and emails (comma separated)
        const contactNumbers = String(row.contact_numbers || "").trim()
          .split(",")
          .map(c => c.trim())
          .filter(c => c.length > 0);

        const emails = String(row.emails || "").trim()
          .split(",")
          .map(e => e.trim())
          .filter(e => e.length > 0);

        // Validate required fields
        if (!product || !company_name) {
          console.warn("⚠️ Skipping row: Missing product or company_name");
          skippedCount++;
          continue;
        }

        // Check for duplicates (product + company_name + matching contact/email)
        const duplicateCheck = await checkDuplicate(connection, product, company_name, contactNumbers, emails);
        
        if (duplicateCheck) {
          duplicateEntries.push({
            product,
            company_name,
            contact_numbers: contactNumbers.join(', '),
            emails: emails.join(', '),
            message: duplicateCheck.message
          });
          skippedCount++;
          continue; // Skip this row
        }

        // Insert into buyers table
        const [buyerResult] = await connection.query(
          `INSERT INTO buyers (
            product,
            hsn_code,
            country,
            company_name,
            website,
            buyer_date,
            address,
            details,
            suggested_keywords,
            hsn_descriptions,
            confidence_level,
            reason,
            classification_notes,
            manual_verification
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            product,
            hsn_code || null,
            country || null,
            company_name,
            website || null,
            buyer_date || null,
            address || null,
            details || null,
            suggested_keywords || null,
            hsn_descriptions || null,
            confidence_level,
            reason || null,
            classification_notes || null,
            manual_verification,
          ]
        );

        const buyerId = buyerResult.insertId;

        // Insert contacts
        if (contactNumbers.length > 0) {
          const contactValues = contactNumbers.map(contact => [buyerId, contact]);
          await connection.query(
            `INSERT INTO buyer_contacts (buyer_id, contact_number) VALUES ?`,
            [contactValues]
          );
        }

        // Insert emails
        if (emails.length > 0) {
          const emailValues = emails.map(email => [buyerId, email]);
          await connection.query(
            `INSERT INTO buyer_emails (buyer_id, email) VALUES ?`,
            [emailValues]
          );
        }

        insertedCount++;
      }

      await connection.commit();

      // Clean up uploaded file
      if (req.file && req.file.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      // Prepare response with duplicate information
      const response = {
        success: true,
        message: "Bulk upload completed",
        inserted: insertedCount,
        skipped: skippedCount,
        total: rows.length,
        duplicates: duplicateEntries
      };

      if (duplicateEntries.length > 0) {
        response.message = `Upload completed with ${duplicateEntries.length} duplicate(s) found and skipped`;
      }

      res.json(response);

    } catch (err) {
      if (connection) {
        try {
          await connection.rollback();
        } catch (rollbackErr) {
          console.error("❌ Rollback error:", rollbackErr);
        }
      }
      console.error("❌ Bulk upload error:", err);
      
      // Clean up uploaded file even on error
      if (req.file && req.file.path && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (unlinkErr) {
          console.error("❌ Error deleting file:", unlinkErr);
        }
      }
      
      res.status(500).json({
        success: false,
        message: err.message || "Bulk upload failed",
      });
    } finally {
      if (connection) {
        try {
          connection.release();
        } catch (releaseErr) {
          console.error("❌ Release connection error:", releaseErr);
        }
      }
    }
  }
);

/* ===============================
   GET ALL BUYERS (with contacts and emails)
================================ */
router.get("/api/buyers/bulk/all", async (req, res) => {
  try {
    const [buyers] = await pool.query(`
      SELECT 
        b.*,
        GROUP_CONCAT(DISTINCT bc.contact_number) as contacts,
        GROUP_CONCAT(DISTINCT be.email) as emails
      FROM buyers b
      LEFT JOIN buyer_contacts bc ON b.id = bc.buyer_id
      LEFT JOIN buyer_emails be ON b.id = be.buyer_id
      GROUP BY b.id
      ORDER BY b.id DESC
    `);

    // Parse contacts and emails into arrays
    const formattedBuyers = buyers.map(buyer => ({
      ...buyer,
      contacts: buyer.contacts ? buyer.contacts.split(',') : [],
      emails: buyer.emails ? buyer.emails.split(',') : [],
    }));

    res.json(formattedBuyers);
  } catch (err) {
    console.error("❌ Fetch buyers error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch buyers",
    });
  }
});

/* ===============================
   GET SINGLE BUYER
================================ */
router.get("/api/buyers/bulk/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [buyerRows] = await pool.query(
      `SELECT * FROM buyers WHERE id = ?`,
      [id]
    );

    if (buyerRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Buyer not found",
      });
    }

    const buyer = buyerRows[0];

    const [contacts] = await pool.query(
      `SELECT contact_number FROM buyer_contacts WHERE buyer_id = ?`,
      [id]
    );

    const [emails] = await pool.query(
      `SELECT email FROM buyer_emails WHERE buyer_id = ?`,
      [id]
    );

    res.json({
      success: true,
      data: {
        ...buyer,
        contacts: contacts.map(c => c.contact_number),
        emails: emails.map(e => e.email),
      },
    });
  } catch (err) {
    console.error("❌ Get buyer error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch buyer",
    });
  }
});

/* ===============================
   UPDATE BUYER
================================ */
router.put("/api/buyers/bulk/:id", async (req, res) => {
  let connection;
  
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const { id } = req.params;
    const {
      product,
      hsn_code,
      country,
      company_name,
      website,
      buyer_date,
      address,
      details,
      suggested_keywords,
      hsn_descriptions,
      confidence_level,
      reason,
      classification_notes,
      manual_verification,
      contacts,
      emails,
    } = req.body;

    // Update buyer
    await connection.query(
      `UPDATE buyers SET
        product = ?,
        hsn_code = ?,
        country = ?,
        company_name = ?,
        website = ?,
        buyer_date = ?,
        address = ?,
        details = ?,
        suggested_keywords = ?,
        hsn_descriptions = ?,
        confidence_level = ?,
        reason = ?,
        classification_notes = ?,
        manual_verification = ?
      WHERE id = ?`,
      [
        product,
        hsn_code || null,
        country || null,
        company_name,
        website || null,
        buyer_date || null,
        address || null,
        details || null,
        suggested_keywords || null,
        hsn_descriptions || null,
        confidence_level || "Medium",
        reason || null,
        classification_notes || null,
        manual_verification || "Pending",
        id,
      ]
    );

    // Delete old contacts and emails
    await connection.query(`DELETE FROM buyer_contacts WHERE buyer_id = ?`, [id]);
    await connection.query(`DELETE FROM buyer_emails WHERE buyer_id = ?`, [id]);

    // Insert new contacts
    if (contacts && Array.isArray(contacts) && contacts.length > 0) {
      const contactValues = contacts
        .filter(c => c.trim())
        .map(contact => [id, contact.trim()]);
      
      if (contactValues.length > 0) {
        await connection.query(
          `INSERT INTO buyer_contacts (buyer_id, contact_number) VALUES ?`,
          [contactValues]
        );
      }
    }

    // Insert new emails
    if (emails && Array.isArray(emails) && emails.length > 0) {
      const emailValues = emails
        .filter(e => e.trim())
        .map(email => [id, email.trim()]);
      
      if (emailValues.length > 0) {
        await connection.query(
          `INSERT INTO buyer_emails (buyer_id, email) VALUES ?`,
          [emailValues]
        );
      }
    }

    await connection.commit();

    res.json({
      success: true,
      message: "Buyer updated successfully",
    });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error("❌ Rollback error:", rollbackErr);
      }
    }
    console.error("❌ Update buyer error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to update buyer",
    });
  } finally {
    if (connection) {
      try {
        connection.release();
      } catch (releaseErr) {
        console.error("❌ Release connection error:", releaseErr);
      }
    }
  }
});

/* ===============================
   DELETE BUYER
================================ */
router.delete("/api/buyers/bulk/:id", async (req, res) => {
  let connection;
  
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const { id } = req.params;

    // Delete related records first
    await connection.query(`DELETE FROM buyer_contacts WHERE buyer_id = ?`, [id]);
    await connection.query(`DELETE FROM buyer_emails WHERE buyer_id = ?`, [id]);
    await connection.query(`DELETE FROM buyers WHERE id = ?`, [id]);

    await connection.commit();

    res.json({
      success: true,
      message: "Buyer deleted successfully",
    });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error("❌ Rollback error:", rollbackErr);
      }
    }
    console.error("❌ Delete buyer error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to delete buyer",
    });
  } finally {
    if (connection) {
      try {
        connection.release();
      } catch (releaseErr) {
        console.error("❌ Release connection error:", releaseErr);
      }
    }
  }
});

module.exports = router;