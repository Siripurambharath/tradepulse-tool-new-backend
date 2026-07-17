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
        phone,
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

// Search users by ID or email
router.get("/users/search", async (req, res) => {
  try {
    const { 
      search = '', 
      page = 1, 
      limit = 10 
    } = req.query;

    const offset = (Number(page) - 1) * Number(limit);
    const limitNum = Number(limit);

    let whereClause = '';
    let params = [];

    // Search filter - search by id or email
    if (search) {
      whereClause = 'WHERE id LIKE ? OR email LIKE ?';
      params.push(`%${search}%`, `%${search}%`);
    }

    // Get total count with search filter
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM users 
      ${whereClause}
    `;
    const [countResult] = await pool.query(countQuery, params);
    const total = countResult[0]?.total || 0;

    // Get paginated users with search filter
    const usersQuery = `
      SELECT 
        user_id,
        id,
        email,
        role,
        email_sent,
        email_config,
        name,
        phone,
        package_id
      FROM users 
      ${whereClause}
      ORDER BY user_id DESC
      LIMIT ? OFFSET ?
    `;

    const queryParams = [...params, limitNum, offset];
    const [rows] = await pool.query(usersQuery, queryParams);

    res.json({
      success: true,
      data: rows,
      total: total,
      pagination: {
        total: total,
        page: Number(page),
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error("Error searching users:", error);
    res.status(500).json({
      success: false,
      message: "Failed to search users",
      error: error.message
    });
  }
});

module.exports = router;