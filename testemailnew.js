/**
 * Dynamic Email Sender
 * Fetches all active email profiles from `email_profiles` table
 * and sends a test email from each profile to the target recipient.
 *
 * Usage:
 *   npm install mysql2 nodemailer
 *   node send_emails_from_profiles.js
 */

const mysql = require("mysql2/promise");
const nodemailer = require("nodemailer");

// ─── CONFIG ────────────────────────────────────────────────────────────────────

const DB_CONFIG = {
  host: "localhost",         // change if your DB is remote
  port: 3306,
  user: "root",              // your MySQL username
  password: "",              // your MySQL password
  database: "seller_buyer_dummy_old",
};

const RECIPIENT_EMAIL = "uppalahemanth4@gmail.com";

// ─── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Build a nodemailer transporter from an email profile row.
 * Supports: gmail (SMTP), custom_smtp, and api_key-based (future).
 */
function buildTransporter(profile) {
  const { smtp_host, smtp_port, username, password, api_key, provider } = profile;

  // If an API key is present (e.g. SendGrid), use it
  if (api_key) {
    // Example: SendGrid via SMTP relay
    return nodemailer.createTransport({
      host: smtp_host || "smtp.sendgrid.net",
      port: smtp_port || 587,
      secure: false,
      auth: {
        user: "apikey",
        pass: api_key,
      },
    });
  }

  // Standard SMTP (Gmail, Titan, Hostinger, etc.)
  const isSecure = Number(smtp_port) === 465; // SSL on 465, STARTTLS on 587

  return nodemailer.createTransport({
    host: smtp_host,
    port: Number(smtp_port),
    secure: isSecure,
    auth: {
      user: username,
      pass: password,
    },
    tls: {
      // Allow self-signed certs in dev; remove in production
      rejectUnauthorized: false,
    },
  });
}

/**
 * Send a test email using the given profile.
 */
async function sendEmailFromProfile(profile) {
  const { id, profile_name, sender_name, sender_email, provider } = profile;

  console.log(`\n📧 [Profile #${id} | ${profile_name}] Sending via ${provider}...`);

  const transporter = buildTransporter(profile);

  const mailOptions = {
    from: `"${sender_name}" <${sender_email}>`,
    to: RECIPIENT_EMAIL,
    subject: `Test Email from Profile: ${profile_name} (ID: ${id})`,
    text: `Hello,\n\nThis is a test email sent from the profile "${profile_name}" (ID: ${id}).\n\nProvider : ${provider}\nSender   : ${sender_name} <${sender_email}>\n\nRegards,\nAuto Mailer`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 8px;">
        <h2 style="color: #4A90E2;">📬 Test Email</h2>
        <p>Hello,</p>
        <p>This is a test email sent from the profile <strong>${profile_name}</strong> (ID: ${id}).</p>
        <table style="border-collapse: collapse; width: 100%; margin-top: 16px;">
          <tr style="background: #f5f5f5;">
            <td style="padding: 8px 12px; font-weight: bold; border: 1px solid #ddd;">Provider</td>
            <td style="padding: 8px 12px; border: 1px solid #ddd;">${provider}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; border: 1px solid #ddd;">Sender Name</td>
            <td style="padding: 8px 12px; border: 1px solid #ddd;">${sender_name}</td>
          </tr>
          <tr style="background: #f5f5f5;">
            <td style="padding: 8px 12px; font-weight: bold; border: 1px solid #ddd;">Sender Email</td>
            <td style="padding: 8px 12px; border: 1px solid #ddd;">${sender_email}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; border: 1px solid #ddd;">Profile ID</td>
            <td style="padding: 8px 12px; border: 1px solid #ddd;">${id}</td>
          </tr>
        </table>
        <p style="margin-top: 24px; color: #888; font-size: 12px;">Sent automatically by Auto Mailer</p>
      </div>
    `,
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`   ✅ Sent! Message ID: ${info.messageId}`);
  return { profileId: id, profileName: profile_name, status: "success", messageId: info.messageId };
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  let connection;

  try {
    console.log("🔌 Connecting to database...");
    connection = await mysql.createConnection(DB_CONFIG);
    console.log("✅ Connected to DB:", DB_CONFIG.database);

    // Fetch all active profiles dynamically
    const [profiles] = await connection.execute(
      "SELECT * FROM email_profiles WHERE is_active = 1 ORDER BY id ASC"
    );

    if (profiles.length === 0) {
      console.log("⚠️  No active email profiles found in email_profiles table.");
      return;
    }

    console.log(`\n📋 Found ${profiles.length} active profile(s). Sending emails to: ${RECIPIENT_EMAIL}`);
    console.log("─".repeat(60));

    const results = [];

    for (const profile of profiles) {
      try {
        const result = await sendEmailFromProfile(profile);
        results.push(result);
      } catch (err) {
        console.error(`   ❌ Failed for Profile #${profile.id} (${profile.profile_name}): ${err.message}`);
        results.push({
          profileId: profile.id,
          profileName: profile.profile_name,
          status: "failed",
          error: err.message,
        });
      }
    }

    // Summary
    console.log("\n" + "─".repeat(60));
    console.log("📊 SUMMARY:");
    results.forEach((r) => {
      const icon = r.status === "success" ? "✅" : "❌";
      const detail = r.status === "success" ? `MsgID: ${r.messageId}` : `Error: ${r.error}`;
      console.log(`   ${icon} [#${r.profileId}] ${r.profileName} — ${detail}`);
    });

    const successCount = results.filter((r) => r.status === "success").length;
    console.log(`\n🎉 Done. ${successCount}/${results.length} email(s) sent successfully.\n`);

  } catch (err) {
    console.error("❌ Fatal error:", err.message);
    process.exit(1);
  } finally {
    if (connection) await connection.end();
  }
}

main();