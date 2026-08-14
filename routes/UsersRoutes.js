const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
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

// GET ALL USERS
// Get all users with pagination
router.get("/users", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // Get total count
    const [countResult] = await pool.query("SELECT COUNT(*) as total FROM users");
    const total = countResult[0]?.total || 0;

    // Get paginated users
    const [rows] = await pool.query(`
      SELECT 
        user_id,
        id,
        email,
        role,
        email_sent,
        email_config,
        name,
        phone_number,
        package_id
      FROM users 
      ORDER BY user_id DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    res.json({
      success: true,
      data: rows,
      total: total,
      page: page,
      limit: limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch users",
      error: error.message
    });
  }
});

// GET USER STATUS BY ID
router.get("/status/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const [rows] = await pool.query(
      `SELECT email_config, email_sent FROM users WHERE id = ?`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    res.json({
      success: true,
      data: rows[0]
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({
      success: false,
      message: "Server Error"
    });
  }
});

// UPSERT USER (CREATE OR UPDATE)
router.put("/api/store-user", async (req, res) => {
  try {
    console.log("=== UPSERT USER REQUEST STARTED ===");
    const {
      id,
      email,
      password,
      role,
      name,
      phone,
      package_id,
      pack_exp_date,
    } = req.body;

    if (!id || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "id, email and password are required",
      });
    }

    // Sanitize values
    const safeRole = role ?? "seller";
    const safeName = name ?? null;
    const safePhone = phone ?? null;
    const safePackageId = package_id ?? null;
    const safePackExpDate = pack_exp_date ?? null;

    // Check if user exists
    const [existing] = await pool.execute(
      "SELECT user_id FROM users WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      // User doesn't exist - INSERT
      console.log(`🆕 User not found, creating new user with ID: ${id}`);
      
      const [result] = await pool.execute(
        `INSERT INTO users
        (id, email, password, role, name, phone_number, package_id, package_expire, email_sent, email_config)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
        [id, email, password, safeRole, safeName, safePhone, safePackageId, safePackExpDate]
      );

      return res.status(201).json({
        success: true,
        message: "User created successfully",
        action: "inserted",
        user_id: result.insertId,
        id,
        email,
        role: safeRole,
        name: safeName,
        phone: safePhone,
        package_id: safePackageId,
        pack_exp_date: safePackExpDate,
      });
    }

    // User exists - UPDATE
    console.log(`✅ User found with ID: ${id}, updating...`);
    
    await pool.execute(
      `UPDATE users
       SET email = ?,
           password = ?,
           role = ?,
           name = ?,
           phone_number = ?,
           package_id = ?,
           package_expire = ?
       WHERE id = ?`,
      [email, password, safeRole, safeName, safePhone, safePackageId, safePackExpDate, id]
    );

    res.json({
      success: true,
      message: "User updated successfully",
      action: "updated",
      id,
      email,
      role: safeRole,
      name: safeName,
      phone: safePhone,
      package_id: safePackageId,
      pack_exp_date: safePackExpDate,
    });

  } catch (err) {
    console.error("Error in /api/store-user (PUT):", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// SELLER LOGIN
router.post("/api/seller/login", async (req, res) => {
  console.log(req.body);
  try {
    const { email, password } = req.body;
    console.log(req.body);
    
    // Validation
    if (!email || !password) {
      return res.status(400).json({
        status: false,
        message: "Email and password are required",
      });
    }

    // Fetch seller
    const [rows] = await pool.execute(
      "SELECT * FROM users WHERE email = ? AND role = ?",
      [email, "seller"]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        status: false,
        message: "Invalid Email or Password",
      });
    }

    const seller = rows[0];

    // Password check
    if (seller.password !== password) {
      return res.status(401).json({
        status: false,
        message: "Invalid Email or Password",
      });
    }

    // Generate token
    const token = jwt.sign(
      {
        id: seller.id,
        email: seller.email,
        role: seller.role,
      },
      process.env.JWT_SECRET || "SECRET_KEY",
      {
        expiresIn: "7d",
      }
    );

    res.json({
      status: true,
      message: "Login successful",
      token,
      seller: {
        id: seller.id,
        email: seller.email,
        role: seller.role,
      },
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      status: false,
      message: "Something went wrong",
    });
  }
});

module.exports = router;