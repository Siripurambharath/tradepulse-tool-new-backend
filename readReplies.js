const Imap = require('node-imap');
const { simpleParser } = require('mailparser');
const mysql = require('mysql2/promise');
require('dotenv').config();
const pool = require("./db");


// const pool = mysql.createPool({
//   host: 'localhost',
//   user: 'root',
//   password: '',
//   database: 'seller_buyer_dummy',
// });

function resolveImapSettings(profile) {
  if (!profile.imap_host) return null;
  return { host: profile.imap_host, port: profile.imap_port || 993 };
}

async function getActiveEmailProfiles() {
  const [rows] = await pool.query(
    `SELECT id, seller_id, profile_name, provider, sender_name, sender_email,
            smtp_host, smtp_port, imap_host, imap_port, username, password, api_key
     FROM email_profiles
     WHERE is_active = 1`
  );
  return rows;
}

async function saveReply({ batchId, productName, fromEmail, toEmail, subject, message, sellerId }) {
  const [existing] = await pool.query(
    `SELECT id FROM email_history_companies
     WHERE batch_id = ? AND from_email = ? AND subject = ?
     LIMIT 1`,
    [batchId, fromEmail, subject]
  );

  if (existing.length > 0) {
    console.log(`Skipping duplicate from: ${fromEmail}`);
    return false;
  }

  const [originalRows] = await pool.query(
    `SELECT company_name, country, contact_name, email, template_used, template_id, product_name, buyer_id
     FROM email_history_companies
     WHERE batch_id = ?
     LIMIT 1`,
    [batchId]
  );

  let company_name = null, country = null, contact_name = null, email = null;
  let template_used = null, template_id = null, buyer_id = null;

  if (originalRows.length > 0) {
    company_name = originalRows[0].company_name;
    country = originalRows[0].country;
    contact_name = originalRows[0].contact_name;
    email = originalRows[0].email;
    template_used = originalRows[0].template_used;
    template_id = originalRows[0].template_id;
    buyer_id = originalRows[0].buyer_id;
  }

  await pool.query(
    `INSERT INTO email_history_companies
      (batch_id, buyer_id, seller_id, company_name, country, contact_name, email, from_email, to_email,
       subject, message, product_name, reply_date, responded_at, status, template_used, template_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 'replied', ?, ?)`,
    [batchId, buyer_id, sellerId, company_name, country, contact_name, email, fromEmail, toEmail,
     subject, message, productName, template_used, template_id]
  );

  console.log(`Saved reply. seller_id: ${sellerId}, buyer_id: ${buyer_id}`);
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

function checkProfileInbox(profile, knownBatchIds) {
  return new Promise((resolve) => {
    const cleanPassword = (profile.password || '').replace(/\s+/g, '');
    const imapSettings = resolveImapSettings(profile);

    if (!imapSettings) {
      console.log(`[${profile.sender_email}] skipped — send-only profile, no IMAP available`);
      return resolve({ processed: 0, saved: 0 });
    }

    const { host: imapHost, port: imapPort } = imapSettings;

    const imap = new Imap({
      user: profile.username,
      password: cleanPassword,
      host: imapHost,
      port: imapPort,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      keepalive: {
        interval: 10000,
        idleInterval: 300000,
        forceNoop: true,
      },
    });

    let processed = 0;
    let saved = 0;

    imap.on('error', (err) => {
      console.error(`[${profile.sender_email}] IMAP error:`, err.message);
      resolve({ processed, saved });
    });

    imap.on('end', () => {
      console.log(`[${profile.sender_email}] disconnected`);
    });

    imap.once('ready', () => {
      console.log(`\n[${profile.sender_email}] checking inbox via ${imapHost}:${imapPort}`);

      imap.openBox('INBOX', false, (err) => {
        if (err) {
          console.error(`[${profile.sender_email}] failed to open INBOX:`, err.message);
          imap.end();
          return resolve({ processed, saved });
        }

        const date = new Date();
        date.setDate(date.getDate() - 7);
        const sinceDate = date.toISOString().split('T')[0];

        imap.search([['SINCE', sinceDate]], (err, results) => {
          if (err) {
            console.error(`[${profile.sender_email}] search error:`, err.message);
            imap.end();
            return resolve({ processed, saved });
          }

          if (!results || results.length === 0) {
            console.log(`[${profile.sender_email}] no emails in last 7 days`);
            imap.end();
            return resolve({ processed, saved });
          }

          console.log(`[${profile.sender_email}] found ${results.length} email(s)`);

          const fetch = imap.fetch(results, { bodies: '', markSeen: false });

          fetch.on('message', (msg) => {
            msg.on('body', (stream) => {
              simpleParser(stream, async (err, parsed) => {
                if (err) {
                  console.error(`[${profile.sender_email}] parse error:`, err.message);
                  return;
                }

                processed++;
                const fromEmail = parsed.from?.value?.[0]?.address || parsed.from?.text || '';
                const toEmail   = parsed.to?.value?.[0]?.address   || parsed.to?.text   || '';
                const subject   = parsed.subject || '';
                const yourEmail = (profile.sender_email || '').toLowerCase();

                const fromAddress = (parsed.from?.value?.[0]?.address || '').toLowerCase();
                if (fromAddress === yourEmail) return;

                if (!subject.toLowerCase().startsWith('re:')) {
                  console.log(`[${profile.sender_email}] skip (not Re:): "${subject}"`);
                  return;
                }

                const { batchId, productName } = extractBatchId(parsed);
                if (!batchId) {
                  console.log(`[${profile.sender_email}] skip (no batchId): "${subject}"`);
                  return;
                }
                if (!knownBatchIds.includes(batchId)) {
                  console.log(`[${profile.sender_email}] skip (batchId ${batchId} not known): "${subject}"`);
                  return;
                }

                const [companyRows] = await pool.query(
                  'SELECT company_name, country, contact_name, email, product_name, buyer_id FROM email_history_companies WHERE batch_id = ? LIMIT 1',
                  [batchId]
                );

                if (companyRows.length === 0) return;
                const finalProductName = companyRows[0].product_name || productName;

                const messageText = parsed.text || parsed.html || '';

                try {
                  const wasSaved = await saveReply({
                    batchId,
                    productName: finalProductName,
                    fromEmail,
                    toEmail,
                    subject,
                    message: messageText,
                    sellerId: profile.seller_id,
                  });
                  if (wasSaved) saved++;
                } catch (dbErr) {
                  console.error(`[${profile.sender_email}] DB save error:`, dbErr.message);
                }
              });
            });
          });

          fetch.on('end', () => {
            console.log(`[${profile.sender_email}] done — processed ${processed}, saved ${saved}`);
            imap.end();
            resolve({ processed, saved });
          });

          fetch.on('error', (err) => {
            console.error(`[${profile.sender_email}] fetch error:`, err.message);
            imap.end();
            resolve({ processed, saved });
          });
        });
      });
    });

    imap.connect();
  });
}

async function checkForReplies() {
  console.log('\nChecking for email replies across all active profiles...');

  let knownBatchIds = [];
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT batch_id FROM email_history_companies WHERE batch_id IS NOT NULL'
    );
    knownBatchIds = rows.map(r => r.batch_id);
  } catch (err) {
    console.error('Failed to fetch batch ids:', err.message);
    return;
  }

  if (knownBatchIds.length === 0) {
    console.log('No batches in DB — nothing to match against');
    return;
  }

  let profiles = [];
  try {
    profiles = await getActiveEmailProfiles();
  } catch (err) {
    console.error('Failed to fetch email profiles:', err.message);
    return;
  }

  if (profiles.length === 0) {
    console.log('No active email profiles found');
    return;
  }

  console.log(`Found ${profiles.length} active profile(s)`);

  let totalProcessed = 0;
  let totalSaved = 0;

  for (const profile of profiles) {
    if (!profile.smtp_host || !profile.username || !profile.password) {
      console.log(`[${profile.profile_name}] skipped — missing host/username/password`);
      continue;
    }

    const result = await checkProfileInbox(profile, knownBatchIds);
    totalProcessed += result.processed;
    totalSaved += result.saved;
  }

  console.log(`\nAll profiles done — processed ${totalProcessed}, saved ${totalSaved} replies`);
}

module.exports = { checkForReplies };