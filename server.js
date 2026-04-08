const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// DB connection
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
});

db.connect((err) => {
  if (err) {
    console.error('Database connection failed:', err);
  } else {
    console.log('Connected to MySQL database');
  }
});

// Get companies
app.get('/companies', (req, res) => {
  db.query('SELECT * FROM companies', (err, result) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Database query failed' });
    }
    res.json(result);
  });
});

// Send Email API
app.post('/send-email', async (req, res) => {
  const { emails, product, subject, message } = req.body;

  if (!emails || emails.length === 0) {
    return res.status(400).json({ error: 'No recipients specified' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    // Create HTML email with proper formatting
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background-color: #f9fafb; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #6b7280; }
          .product { font-weight: bold; color: #4F46E5; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>Business Opportunity</h2>
          </div>
          <div class="content">
            ${message.replace(/\n/g, '<br/>')}
            <br/><br/>
            <p>Product/Service: <span class="product">${product}</span></p>
            <br/>
            <p>Best regards,<br/>Trade Platform Team</p>
          </div>
          <div class="footer">
            <p>This is an automated message from Trade Platform. Please reply to this email for any inquiries.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: `"Trade Platform" <${process.env.EMAIL_USER}>`,
      to: emails.join(','),
      subject: subject || `Business Opportunity - ${product}`,
      html: htmlContent,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent:', info.messageId);
    
    res.json({ 
      success: true, 
      messageId: info.messageId,
      recipientsCount: emails.length 
    });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: 'Failed to send email', details: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));