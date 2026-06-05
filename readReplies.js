const Imap = require('node-imap');
const { simpleParser } = require('mailparser');
const mysql = require('mysql2/promise');
require('dotenv').config();

/* ─────────────────────────────────────────────
   MYSQL
───────────────────────────────────────────── */

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'seller_buyer_dummy',
});

/* ─────────────────────────────────────────────
   DB HELPERS
───────────────────────────────────────────── */

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_replies (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      batch_id    VARCHAR(255) NOT NULL,
      history_id  INT,
      from_email  VARCHAR(255),
      to_email    VARCHAR(255),
      subject     TEXT,
      message     LONGTEXT,
      product_name VARCHAR(255),
      reply_date  DATETIME,
      
      INDEX idx_batch (batch_id),
      INDEX idx_history (history_id)
    )
  `);
}

async function saveReply({ batchId, historyId, productName, fromEmail, toEmail, subject, message }) {
  const [existing] = await pool.query(
    `SELECT id FROM email_replies
     WHERE batch_id = ? AND from_email = ? AND subject = ?
     LIMIT 1`,
    [batchId, fromEmail, subject]
  );

  if (existing.length > 0) {
    console.log(`⏭️  Already saved — skipping duplicate from: ${fromEmail}`);
    return false;
  }

  await pool.query(
    `INSERT INTO email_replies
      (batch_id, history_id, product_name, from_email, to_email, subject, message, reply_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [batchId, historyId, productName, fromEmail, toEmail, subject, message]
  );

  return true;
}

/* ─────────────────────────────────────────────
   BATCH ID EXTRACTION
───────────────────────────────────────────── */
function extractBatchId(parsed) {
  const subject = parsed.subject || '';
  let batchId = null;
  let productName = null;

  // Strategy 1: [BATCH:xxx] in subject
  const subjectBatchMatch = subject.match(/\[BATCH:([^\]]+)\]/);
  const subjectProductMatch = subject.match(/\[PRODUCT:([^\]]+)\]/);
  
  if (subjectBatchMatch) {
    console.log(`✅ Found batch in subject: ${subjectBatchMatch[1]}`);
    batchId = subjectBatchMatch[1];
  }
  if (subjectProductMatch) {
    productName = subjectProductMatch[1];
  }

  // Strategy 2: References header
  if (!batchId && parsed.references) {
    const refsStr = Array.isArray(parsed.references)
      ? parsed.references.join(' ')
      : String(parsed.references);
    const refBatchMatch = refsStr.match(/\[BATCH:([^\]]+)\]/);
    const refProductMatch = refsStr.match(/\[PRODUCT:([^\]]+)\]/);
    
    if (refBatchMatch) batchId = refBatchMatch[1];
    if (refProductMatch) productName = refProductMatch[1];
  }

  // Strategy 3: In-Reply-To header
  if (!batchId && parsed.inReplyTo) {
    const replyToStr = String(parsed.inReplyTo);
    const replyBatchMatch = replyToStr.match(/\[BATCH:([^\]]+)\]/);
    const replyProductMatch = replyToStr.match(/\[PRODUCT:([^\]]+)\]/);
    
    if (replyBatchMatch) batchId = replyBatchMatch[1];
    if (replyProductMatch) productName = replyProductMatch[1];
  }

  // Strategy 4: Plain-text body
  if ((!batchId || !productName) && parsed.text) {
    if (!batchId) {
      const bodyBatchMatch = parsed.text.match(/\[BATCH:([^\]]+)\]/);
      if (bodyBatchMatch) batchId = bodyBatchMatch[1];
    }
    if (!productName) {
      const bodyProductMatch = parsed.text.match(/\[PRODUCT:([^\]]+)\]/);
      if (bodyProductMatch) productName = bodyProductMatch[1];
    }
  }

  return { batchId, productName };
}

/* ─────────────────────────────────────────────
   IMAP — CHECK FOR REPLIES
───────────────────────────────────────────── */

function checkForReplies() {
  const imap = new Imap({
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASS,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    keepalive: {
      interval: 10000,
      idleInterval: 300000,
      forceNoop: true,
    },
  });

  imap.on('error', (err) => {
    if (err.code === 'ECONNRESET') {
      console.warn('⚠️  Gmail closed the connection (ECONNRESET) — will retry on next poll');
    } else {
      console.error('IMAP error:', err.message);
    }
  });

  imap.on('end', () => console.log('🔌 IMAP disconnected\n'));

  imap.once('ready', () => {
    console.log('\n📬 Checking for email replies...');

    imap.openBox('INBOX', false, (err) => {
      if (err) {
        console.error('Failed to open INBOX:', err.message);
        return imap.end();
      }

      const date = new Date();
      date.setDate(date.getDate() - 7); // Last 7 days
      const sinceDate = date.toISOString().split('T')[0];
      
      imap.search([['SINCE', sinceDate]], (err, results) => {
        if (err) {
          console.error('Search error:', err.message);
          return imap.end();
        }

        if (!results || results.length === 0) {
          console.log('📭 No emails found in last 7 days');
          return imap.end();
        }

        console.log(`📩 Found ${results.length} email(s) from last 7 days`);

        // 👉 Don't mark as seen - leave emails unchanged
        const fetch = imap.fetch(results, { bodies: '', markSeen: false });
        let processed = 0;
        let saved = 0;

        fetch.on('message', (msg) => {
          msg.on('body', (stream) => {
            simpleParser(stream, async (err, parsed) => {
              if (err) {
                console.error('Parse error:', err.message);
                return;
              }

              processed++;
              const fromEmail = parsed.from?.text || '';
              const toEmail   = parsed.to?.text   || '';
              const subject   = parsed.subject    || '';
              const yourEmail = (process.env.EMAIL_USER || '').toLowerCase();

              console.log(`\n=== EMAIL #${processed} ===`);
              console.log('From:   ', fromEmail);
              console.log('Subject:', subject);

              const fromAddress = (parsed.from?.value?.[0]?.address || '').toLowerCase();
              
              if (fromAddress === yourEmail) {
                console.log(`⏭️  Skipped — this is YOUR email (not a customer reply)`);
                return;
              }

              const isReply = subject.toLowerCase().startsWith('re:');
              if (!isReply) {
                console.log(`⏭️  Skipped — not a reply email (missing "Re:" in subject)`);
                return;
              }
              
              const { batchId } = extractBatchId(parsed);

              if (!batchId) {
                console.log(`❌ No batch ID found — skipping`);
                return;
              }

              // Fetch history_id and product from email_history table
              const [historyRows] = await pool.query(
                'SELECT id, product FROM email_history WHERE id = ?', 
                [batchId]
              );

              let historyId = null;
              let productName = null;

              if (historyRows.length > 0) {
                historyId = historyRows[0].id;
                productName = historyRows[0].product;
                console.log(`📋 Found history record - ID: ${historyId}, Product: ${productName}`);
              } else {
                console.log(`⚠️ No history record found for batch_id: ${batchId}`);
              }

              const messageText = parsed.text || parsed.html || '';

              try {
                const wasSaved = await saveReply({
                  batchId,
                  historyId: historyId,
                  productName: productName || null,
                  fromEmail,
                  toEmail,
                  subject,
                  message: messageText,
                });

                if (wasSaved) {
                  console.log(`✅✅✅ SAVED customer reply from ${fromEmail} → batch ${batchId} (history_id: ${historyId})`);
                  saved++;
                }
              } catch (dbErr) {
                console.error('DB save error:', dbErr.message);
              }
            });
          });
        });

        fetch.on('end', () => {
          console.log(`\n✅ Done — processed ${processed}, saved ${saved} customer replies`);
          imap.end();
        });

        fetch.on('error', (err) => {
          console.error('Fetch error:', err.message);
          imap.end();
        });
      });
    });
  });

  imap.connect();
}

/* ─────────────────────────────────────────────
   BOOT
───────────────────────────────────────────── */

(async () => {
  await ensureTable();
  console.log('✅ email_replies table ready');

  checkForReplies();
  setInterval(checkForReplies, 2 * 60 * 1000);
})();