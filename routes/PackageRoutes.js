const express = require("express");
const router = express.Router();
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
router.get("/users", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM users");

    res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Error fetching users:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch users",
      error: error.message,
    });
  }
});

module.exports = router;