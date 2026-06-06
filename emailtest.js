const mysql = require("mysql2/promise");
const nodemailer = require("nodemailer");

const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "buyer-seller",
});

async function sendTestEmail() {
  try {
    const profileId = 2;

    const [rows] = await pool.execute(
      "SELECT * FROM email_profiles WHERE id = ?",
      [profileId]
    );

    if (rows.length === 0) {
      console.log("Email profile not found");
      return;
    }

    const profile = rows[0];

    console.log("Using Profile:");
    console.log({
      id: profile.id,
      profile_name: profile.profile_name,
      provider: profile.provider,
      sender_email: profile.sender_email,
      smtp_host: profile.smtp_host,
      smtp_port: profile.smtp_port,
    });

    const transporter = nodemailer.createTransport({
      host: profile.smtp_host,
      port: Number(profile.smtp_port),
      secure: Number(profile.smtp_port) === 465,
      auth: {
        user: profile.username,
        pass: profile.password,
      },
      tls: {
        rejectUnauthorized: false,
      },
    });

    await transporter.verify();

    console.log("SMTP Connection Successful");

    const info = await transporter.sendMail({
      from: `"${profile.sender_name}" <${profile.sender_email}>`,
      to: "uppalahemanth4@gmail.com",
      subject: "Test Email From Buyer Seller App",
      html: `
        <h2>Email Test Successful ✅</h2>
        <p>Provider: ${profile.provider}</p>
        <p>Profile: ${profile.profile_name}</p>
        <p>Email sent using configuration ID ${profile.id}</p>
      `,
    });

    console.log("Email Sent Successfully");
    console.log("Message ID:", info.messageId);

    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

sendTestEmail();