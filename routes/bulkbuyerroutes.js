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
   DEFINED COLUMN HEADERS (Template Schema)
================================ */
const REQUIRED_COLUMNS = [
  "product",
  "hsn_code",
  "country",
  "company_name",
  "website",
  "buyer_date",
  "address",
  "additional_details",
  "suggested_keywords",
  "hsn_descriptions",
  "confidence_level",
  "reason",
  "classification_notes",
  "manual_verification",
  "contact_numbers",
  "emails"
];

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
        additional_details: "",
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
        additional_details: "",
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
      { wch: 40 }, // additional_details
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
   VALIDATE SCHEMA FUNCTION
================================ */
const validateSchema = (headers) => {
  const normalizedHeaders = headers.map(h => h.toLowerCase().trim());
  
  const missingColumns = REQUIRED_COLUMNS.filter(
    required => !normalizedHeaders.includes(required.toLowerCase())
  );
  
  const extraColumns = normalizedHeaders.filter(
    header => !REQUIRED_COLUMNS.map(c => c.toLowerCase()).includes(header)
  );
  
  const missingOriginal = REQUIRED_COLUMNS.filter(
    required => !headers.some(h => h.toLowerCase().trim() === required.toLowerCase())
  );
  
  const extraOriginal = headers.filter(
    header => !REQUIRED_COLUMNS.some(required => required.toLowerCase() === header.toLowerCase().trim())
  );
  
  return {
    isValid: missingColumns.length === 0 && extraColumns.length === 0,
    missingColumns: missingOriginal,
    extraColumns: extraOriginal,
  };
};

/* ===============================
   CHECK DUPLICATE FUNCTION - IMPROVED
================================ */
const checkDuplicate = async (connection, product, company_name, newContactNumbers, newEmails) => {
  try {
    // Find existing buyers with same product and company name
    const [existingBuyers] = await connection.query(
      `SELECT id FROM buyers WHERE product = ? AND company_name = ?`,
      [product, company_name]
    );

    if (existingBuyers.length === 0) {
      return null; // No duplicate found
    }

    // Check each existing buyer
    for (const buyer of existingBuyers) {
      const buyerId = buyer.id;

      // Get existing contacts for this buyer
      const [existingContacts] = await connection.query(
        `SELECT contact_number FROM buyer_contacts WHERE buyer_id = ?`,
        [buyerId]
      );
      const existingContactNumbers = existingContacts.map(c => c.contact_number);

      // Get existing emails for this buyer
      const [existingEmails] = await connection.query(
        `SELECT email FROM buyer_emails WHERE buyer_id = ?`,
        [buyerId]
      );
      const existingEmailAddresses = existingEmails.map(e => e.email);

      // Check if ALL new contacts match ALL existing contacts (in any order)
      // AND ALL new emails match ALL existing emails (in any order)
      const contactsMatch = newContactNumbers.length === existingContactNumbers.length &&
        newContactNumbers.every(contact => existingContactNumbers.includes(contact));

      const emailsMatch = newEmails.length === existingEmailAddresses.length &&
        newEmails.every(email => existingEmailAddresses.includes(email));

      // If both contacts and emails match exactly, it's a duplicate
      if (contactsMatch && emailsMatch) {
        return {
          exists: true,
          buyerId: buyerId,
          message: `Duplicate found: Product "${product}" with Company "${company_name}" already exists with same contacts and emails`
        };
      }
    }

    return null; // No exact duplicate found
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

      const headers = Object.keys(rows[0]);
      const schemaValidation = validateSchema(headers);
      
      if (!schemaValidation.isValid) {
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        
        return res.status(400).json({
          success: false,
          schemaMismatch: true,
          message: "Schema mismatch detected. Please download the template and use the exact column headers.",
          missingColumns: schemaValidation.missingColumns,
          extraColumns: schemaValidation.extraColumns
        });
      }

      for (const row of rows) {
        const additional_details = String(row.additional_details || row.details || "").trim();
        const product = String(row.product || "").trim();
        const hsn_code = String(row.hsn_code || "").trim();
        const country = String(row.country || "").trim();
        const company_name = String(row.company_name || "").trim();
        const website = String(row.website || "").trim();
        const buyer_date = row.buyer_date || null;
        const address = String(row.address || "").trim();
        const suggested_keywords = String(row.suggested_keywords || "").trim();
        const hsn_descriptions = String(row.hsn_descriptions || "").trim();
        const confidence_level = String(row.confidence_level || "Medium").trim();
        const reason = String(row.reason || "").trim();
        const classification_notes = String(row.classification_notes || "").trim();
        const manual_verification = String(row.manual_verification || "Pending").trim();

        const contactNumbers = String(row.contact_numbers || "").trim()
          .split(",")
          .map(c => c.trim())
          .filter(c => c.length > 0)
          .sort(); // Sort for consistent comparison

        const emails = String(row.emails || "").trim()
          .split(",")
          .map(e => e.trim())
          .filter(e => e.length > 0)
          .sort(); // Sort for consistent comparison

        if (!product || !company_name) {
          console.warn("⚠️ Skipping row: Missing product or company_name");
          skippedCount++;
          continue;
        }

        // Check for duplicates
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
          continue;
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
            additional_details,
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
            additional_details || null,
            suggested_keywords || null,
            hsn_descriptions || null,
            confidence_level,
            reason || null,
            classification_notes || null,
            manual_verification,
          ]
        );

        const buyerId = buyerResult.insertId;

        if (contactNumbers.length > 0) {
          const contactValues = contactNumbers.map(contact => [buyerId, contact]);
          await connection.query(
            `INSERT INTO buyer_contacts (buyer_id, contact_number) VALUES ?`,
            [contactValues]
          );
        }

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

      if (req.file && req.file.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

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
        GROUP_CONCAT(DISTINCT bc.contact_number ORDER BY bc.contact_number) as contacts,
        GROUP_CONCAT(DISTINCT be.email ORDER BY be.email) as emails
      FROM buyers b
      LEFT JOIN buyer_contacts bc ON b.id = bc.buyer_id
      LEFT JOIN buyer_emails be ON b.id = be.buyer_id
      GROUP BY b.id
      ORDER BY b.id DESC
    `);

    const formattedBuyers = buyers.map(buyer => ({
      ...buyer,
      contacts: buyer.contacts ? buyer.contacts.split(',').sort() : [],
      emails: buyer.emails ? buyer.emails.split(',').sort() : [],
    }));

    res.json({
      success: true,
      data: formattedBuyers
    });
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
      `SELECT contact_number FROM buyer_contacts WHERE buyer_id = ? ORDER BY contact_number`,
      [id]
    );

    const [emails] = await pool.query(
      `SELECT email FROM buyer_emails WHERE buyer_id = ? ORDER BY email`,
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
      additional_details,
      suggested_keywords,
      hsn_descriptions,
      confidence_level,
      reason,
      classification_notes,
      manual_verification,
      contacts,
      emails,
    } = req.body;

    await connection.query(
      `UPDATE buyers SET
        product = ?,
        hsn_code = ?,
        country = ?,
        company_name = ?,
        website = ?,
        buyer_date = ?,
        address = ?,
        additional_details = ?,
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
        additional_details || null,
        suggested_keywords || null,
        hsn_descriptions || null,
        confidence_level || "Medium",
        reason || null,
        classification_notes || null,
        manual_verification || "Pending",
        id,
      ]
    );

    await connection.query(`DELETE FROM buyer_contacts WHERE buyer_id = ?`, [id]);
    await connection.query(`DELETE FROM buyer_emails WHERE buyer_id = ?`, [id]);

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