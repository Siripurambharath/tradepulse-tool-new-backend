const Imap = require('node-imap');
const { simpleParser } = require('mailparser');
const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'seller_buyer_dummy',
});



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

function extractBatchId(parsed) {
  const subject = parsed.subject || '';
  let batchId = null;
  let productName = null;

  const subjectBatchMatch   = subject.match(/\[BATCH:([^\]]+)\]/);
  const subjectProductMatch = subject.match(/\[PRODUCT:([^\]]+)\]/);

  if (subjectBatchMatch)   batchId     = subjectBatchMatch[1];
  if (subjectProductMatch) productName = subjectProductMatch[1];

  if (!batchId && parsed.references) {
    const refsStr = Array.isArray(parsed.references)
      ? parsed.references.join(' ')
      : String(parsed.references);
    const m = refsStr.match(/\[BATCH:([^\]]+)\]/);
    const p = refsStr.match(/\[PRODUCT:([^\]]+)\]/);
    if (m) batchId     = m[1];
    if (p) productName = p[1];
  }

  if (!batchId && parsed.inReplyTo) {
    const s = String(parsed.inReplyTo);
    const m = s.match(/\[BATCH:([^\]]+)\]/);
    const p = s.match(/\[PRODUCT:([^\]]+)\]/);
    if (m) batchId     = m[1];
    if (p) productName = p[1];
  }

  if ((!batchId || !productName) && parsed.text) {
    if (!batchId) {
      const m = parsed.text.match(/\[BATCH:([^\]]+)\]/);
      if (m) batchId = m[1];
    }
    if (!productName) {
      const p = parsed.text.match(/\[PRODUCT:([^\]]+)\]/);
      if (p) productName = p[1];
    }
  }

  return { batchId, productName };
}

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
      console.warn('⚠️  ECONNRESET — will retry on next poll');
    } else {
      console.error('IMAP error:', err.message);
    }
  });

  imap.on('end', () => console.log('🔌 IMAP disconnected\n'));

  imap.once('ready', async () => {
    console.log('\n📬 Checking for email replies...');

    // ✅ Step 1: Fetch all known batch_ids from email_history
    let knownBatchIds = [];
    try {
      const [rows] = await pool.query(
        'SELECT batch_id FROM email_history WHERE batch_id IS NOT NULL'
      );
      knownBatchIds = rows.map(r => r.batch_id);
      console.log(`📋 Found ${knownBatchIds.length} known batch(es) in DB`);
    } catch (err) {
      console.error('Failed to fetch batch ids:', err.message);
      return imap.end();
    }

    if (knownBatchIds.length === 0) {
      console.log('📭 No batches in DB — nothing to match against');
      return imap.end();
    }

    imap.openBox('INBOX', false, (err) => {
      if (err) {
        console.error('Failed to open INBOX:', err.message);
        return imap.end();
      }

      // ✅ Step 2: Only fetch emails since earliest batch was sent
      const date = new Date();
      date.setDate(date.getDate() - 7);
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

        console.log(`📩 Found ${results.length} email(s) — filtering by known batches...`);

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
              const fromEmail = parsed.from?.value?.[0]?.address || parsed.from?.text || '';
              const toEmail   = parsed.to?.value?.[0]?.address   || parsed.to?.text   || '';
              const subject   = parsed.subject || '';
              const yourEmail = (process.env.EMAIL_USER || '').toLowerCase();

              console.log(`\n=== EMAIL #${processed} ===`);
              console.log('From:   ', fromEmail);
              console.log('Subject:', subject);

              // ✅ Skip own emails
              const fromAddress = (parsed.from?.value?.[0]?.address || '').toLowerCase();
              if (fromAddress === yourEmail) {
                console.log(`⏭️  Skipped — your own email`);
                return;
              }

              // ✅ Skip non-replies
              if (!subject.toLowerCase().startsWith('re:')) {
                console.log(`⏭️  Skipped — not a reply`);
                return;
              }

              const { batchId } = extractBatchId(parsed);

              if (!batchId) {
                console.log(`❌ No batch ID found — skipping`);
                return;
              }

              // ✅ Step 3: Only process if batchId exists in our DB
              if (!knownBatchIds.includes(batchId)) {
                console.log(`⏭️  Skipped — batchId ${batchId} not in our DB`);
                return;
              }

              // ✅ Step 4: Fetch id + product using batch_id (fixed column name)
              const [historyRows] = await pool.query(
                'SELECT id, product FROM email_history WHERE batch_id = ?',
                [batchId]
              );

              let historyId   = null;
              let productName = null;

              if (historyRows.length > 0) {
                historyId   = historyRows[0].id;       // ✅ correct — auto increment id
                productName = historyRows[0].product;
                console.log(`📋 Matched history — id: ${historyId}, product: ${productName}`);
              } else {
                console.log(`⚠️ No history record found for batch_id: ${batchId}`);
                return; // ✅ skip if no parent record
              }

              const messageText = parsed.text || parsed.html || '';

              try {
                const wasSaved = await saveReply({
                  batchId,
                  historyId,
                  productName,
                  fromEmail,
                  toEmail,
                  subject,
                  message: messageText,
                });

                if (wasSaved) {
                  console.log(`✅ SAVED reply from ${fromEmail} → batch ${batchId} (history_id: ${historyId})`);
                  saved++;
                }
              } catch (dbErr) {
                console.error('DB save error:', dbErr.message);
              }
            });
          });
        });

        fetch.on('end', () => {
          console.log(`\n✅ Done — processed ${processed}, saved ${saved} replies`);
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

module.exports = { checkForReplies };