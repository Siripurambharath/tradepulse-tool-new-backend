// const express = require("express");
// const mysql = require("mysql2/promise");
// const cors = require("cors");
// const session = require("express-session");
// const pool = require("./db");

// const nodemailer = require("nodemailer");
// const Bull = require("bull");
// const { createBullBoard } = require("@bull-board/api");
// const { BullAdapter } = require("@bull-board/api/bullAdapter");
// const { ExpressAdapter } = require("@bull-board/express");
// const jwt = require("jsonwebtoken");
// require("dotenv").config();

// const buyerRoutes = require("./routes/buyerroutes");
// const ssoRouter = require("./routes/ssoRoute");
// const templates = require("./routes/templates");
// const historyDetailRoutes = require("./routes/historyDetailRoutes");
// const bulkBuyerRoutes = require("./routes/bulkbuyerroutes");
// const userRoutes = require("./routes/UsersRoutes");
// const trackingroutes = require("./routes/trackingroutes");
// const contactroutes = require("./routes/contactroutes");
// const emailconfigroutes = require("./routes/emailconfigroutes");
// const searchroutes = require("./routes/searchroutes");
// const Admindashboard = require("./routes/Admindashboard");

// const app = express();

// // ─────────────────────────────────────────────
// // 1. CORS — defined BEFORE use
// // ─────────────────────────────────────────────
// const allowedOrigins = [
//   "https://test-buyers.globpulse.com",
//   "https://buyers.globpulse.com",
//   "https://gfe-seller-dashboard.com",
//   "http://localhost:8080",
//   "http://localhost:5173",
//   "http://127.0.0.1:3000",
//   "http://127.0.0.1:5173",
// ];

// app.use(
//   cors({
//     origin: (origin, callback) => {
//       // allow non-browser tools (Postman, curl) which send no origin
//       if (!origin || allowedOrigins.includes(origin)) {
//         return callback(null, true);
//       }
//       return callback(new Error(`Not allowed by CORS: ${origin}`));
//     },
//     credentials: true,
//   })
// );

// app.use(express.json({ limit: "10mb" }));

// // ─────────────────────────────────────────────
// // 2. Session — dev-safe cookies
// // ─────────────────────────────────────────────
// const isProd = process.env.NODE_ENV === "production";

// app.use(
//   session({
//     secret: process.env.SESSION_SECRET || "dev-secret-change-me",
//     resave: false,
//     saveUninitialized: false,
//     cookie: {
//       secure: isProd, // false on localhost
//       httpOnly: true,
//       sameSite: isProd ? "none" : "lax", // lax locally
//       maxAge: 24 * 60 * 60 * 1000,
//     },
//   })
// );

// // ─────────────────────────────────────────────
// // 3. Pools
// // ─────────────────────────────────────────────
// // LOCAL pool (./db) — used everywhere EXCEPT the package APIs below
// app.set("pool", pool);

// // HARDCODED REMOTE pool — used ONLY by the package-related endpoints
// const remotePool = mysql.createPool({
//   host: "89.116.20.241",
//   user: "b2b_remote_user_b2b",
//   password: "RK^D??9DSgX5Z=;B",
//   database: "b2b_remote_db",
//   waitForConnections: true,
//   connectionLimit: 5,
//   dateStrings: true,
// });

// // sanity-check remote connection once at boot
// remotePool
//   .query("SELECT 1 AS ok")
//   .then(() => console.log("✅ remotePool connected to 89.116.20.241 / b2b_remote_db"))
//   .catch((e) => console.error("❌ remotePool connection failed:", e.message));

// // expose globally so inline routes work
// global.remotePool = remotePool;
// app.set("remotePool", remotePool);

// // ─────────────────────────────────────────────
// // 4. Email profile helpers
// // ─────────────────────────────────────────────
// async function getEmailProfileBySellerId(sellerId) {
//   const [rows] = await pool.query(
//     `SELECT * FROM email_profiles
//      WHERE seller_id = ? AND is_active = 1
//      ORDER BY id DESC
//      LIMIT 1`,
//     [sellerId]
//   );
//   if (!rows.length) {
//     throw new Error(`No active email profile found for seller_id: ${sellerId}`);
//   }
//   return rows[0];
// }

// function createTransporterFromProfile(profile) {
//   if (profile.api_key) {
//     return nodemailer.createTransport({
//       host: profile.smtp_host || "smtp.sendgrid.net",
//       port: profile.smtp_port || 587,
//       secure: false,
//       auth: { user: "apikey", pass: profile.api_key },
//       tls: { rejectUnauthorized: false },
//     });
//   }

//   return nodemailer.createTransport({
//     host: profile.smtp_host,
//     port: profile.smtp_port || 587,
//     secure: Number(profile.smtp_port) === 465,
//     auth: {
//       user: profile.username,
//       pass: profile.password,
//     },
//     tls: { rejectUnauthorized: false },
//   });
// }

// const transporterCache = new Map();
// function getCachedTransporter(profile) {
//   if (transporterCache.has(profile.id)) return transporterCache.get(profile.id);
//   const t = createTransporterFromProfile(profile);
//   transporterCache.set(profile.id, t);
//   return t;
// }

// // ─────────────────────────────────────────────
// // 5. Bull queue
// // ─────────────────────────────────────────────
// const emailQueue = new Bull("email-queue", {
//   redis: {
//     host: process.env.REDIS_HOST || "127.0.0.1",
//     port: Number(process.env.REDIS_PORT || 6379),
//   },
//   limiter: { max: 20, duration: 60000 },
// });

// const serverAdapter = new ExpressAdapter();
// serverAdapter.setBasePath("/admin/queues");
// createBullBoard({
//   queues: [new BullAdapter(emailQueue)],
//   serverAdapter,
// });
// app.use("/admin/queues", serverAdapter.getRouter());

// // ─────────────────────────────────────────────
// // 6. Email HTML builder
// // ─────────────────────────────────────────────
// function buildHtml(message, product, interestedUrl, notInterestedUrl) {
//   return `
//     <!DOCTYPE html><html><head><style>
//       body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
//       .container { max-width: 600px; margin: 0 auto; padding: 20px; }
//       .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; }
//       .content { padding: 20px; background-color: #f9fafb; }
//       .footer { padding: 20px; text-align: center; font-size: 12px; color: #6b7280; }
//       .product { font-weight: bold; color: #4F46E5; }
//       .btn-row { margin-top: 24px; }
//       .btn { display:inline-block; padding:12px 28px; border-radius:6px;
//              text-decoration:none; font-weight:bold; font-size:15px; margin-right:12px; }
//       .btn-yes { background-color:#22c55e; color:white; }
//       .btn-no  { background-color:#ef4444; color:white; }
//       .note { font-size:12px; color:#9ca3af; margin-top:16px; }
//     </style></head><body>
//       <div class="container">
//         <div class="header"><h2>Business Opportunity</h2></div>
//         <div class="content">
//           ${(message || "").replace(/\n/g, "<br/>")}
//           <br/><br/>
//           <p>Product/Service: <span class="product">${product || ""}</span></p>
//           <p><strong>Are you interested in this product?</strong></p>
//           <div class="btn-row">
//             <a href="${interestedUrl}" class="btn btn-yes">✅ Interested</a>
//             <a href="${notInterestedUrl}" class="btn btn-no">❌ Not Interested</a>
//           </div>
//           <p class="note">Clicking a button records your response. You can only respond once.</p>
//           <br/>
//           <p>Best regards,<br/>Trade Platform Team</p>
//         </div>
//         <div class="footer">
//           <p>This is an automated message from Trade Platform.</p>
//         </div>
//       </div>
//     </body></html>`;
// }

// // ─────────────────────────────────────────────
// // 7. Queue processor
// // ─────────────────────────────────────────────
// emailQueue.process(async (job) => {
//   const {
//     recipientEmail,
//     subject,
//     message,
//     product,
//     originalProduct,
//     company,
//     batchId,
//     sellerId,
//     emailProfile,
//     cc = [],
//     hasCc = false,
//   } = job.data;

//   console.log(
//     `📧 Job ${job.id} → ${recipientEmail} | batch ${batchId} | profile ${emailProfile?.profile_name}`
//   );

//   await job.progress(20);

//   const trackedSubject = `${subject || `Business Opportunity - ${product}`} [BATCH:${batchId}]`;

//   let sendStatus = "Sent";
//   let sendError = null;
//   let messageId = null;

//   try {
//     if (!emailProfile) throw new Error("No email profile attached to job");

//     const transporter = getCachedTransporter(emailProfile);
//     const BASE_URL = process.env.BASE_URL || "http://localhost:5000";

//     const interestedUrl = `${BASE_URL}/track-response?batchId=${batchId}&email=${encodeURIComponent(
//       recipientEmail
//     )}&response=interested`;
//     const notInterestedUrl = `${BASE_URL}/track-response?batchId=${batchId}&email=${encodeURIComponent(
//       recipientEmail
//     )}&response=not_interested`;

//     const mailOptions = {
//       from: `"${emailProfile.sender_name}" <${emailProfile.sender_email}>`,
//       to: recipientEmail,
//       cc: hasCc && cc.length > 0 ? cc.join(", ") : undefined,
//       subject: trackedSubject,
//       html: buildHtml(message, originalProduct, interestedUrl, notInterestedUrl),
//       headers: {
//         "X-Batch-ID": batchId,
//         "X-Product": product,
//         "Message-ID": `<${batchId}-${Date.now()}@yourdomain.com>`,
//         "X-CC-Enabled": hasCc ? "true" : "false",
//         "X-CC-Recipients": hasCc ? cc.join(", ") : "",
//       },
//     };

//     const info = await transporter.sendMail(mailOptions);
//     messageId = info.messageId;
//     console.log(`✅ Sent to ${recipientEmail} [${messageId}]`);
//     await job.progress(70);
//   } catch (err) {
//     console.error(`❌ Failed to send to ${recipientEmail}:`, err.message);
//     sendStatus = "Failed";
//     sendError = err;
//     await job.progress(70);
//   }

//   // ── persist history ──
//   try {
//     const [existing] = await pool.query(
//       `SELECT id FROM email_history_companies WHERE batch_id = ? AND email = ?`,
//       [batchId, recipientEmail]
//     );

//     const contactValue =
//       company.contacts ||
//       company.contact_number ||
//       company.contactName ||
//       company.companyName ||
//       "Unknown";

//     if (existing.length > 0) {
//       await pool.query(
//         `UPDATE email_history_companies
//          SET sent_at = ?, status = ?, template_used = ?, template_id = ?,
//              product_name = ?, multiple_products = ?, buyer_id = ?, seller_id = ?,
//              contact_name = ?, hsn_code = ?, has_cc = ?, cc_emails = ?
//          WHERE batch_id = ? AND email = ?`,
//         [
//           new Date(),
//           sendStatus,
//           company.templateUsed || "Welcome Template",
//           company.templateId,
//           originalProduct,
//           job.data.multipleProducts || false,
//           company.buyer_id,
//           sellerId,
//           contactValue,
//           company.hsn_code || "",
//           hasCc ? 1 : 0,
//           JSON.stringify(cc),
//           batchId,
//           recipientEmail,
//         ]
//       );
//     } else {
//       await pool.query(
//         `INSERT INTO email_history_companies
//            (batch_id, seller_id, buyer_id, company_name, country, contact_name, email,
//             sent_at, status, template_used, template_id, product_name, multiple_products,
//             hsn_code, has_cc, cc_emails)
//          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
//         [
//           batchId,
//           sellerId,
//           company.buyer_id,
//           company.companyName || "Unknown",
//           company.country || null,
//           contactValue,
//           recipientEmail,
//           new Date(),
//           sendStatus,
//           company.templateUsed || "Welcome Template",
//           company.templateId,
//           originalProduct,
//           job.data.multipleProducts || false,
//           company.hsn_code || "",
//           hasCc ? 1 : 0,
//           JSON.stringify(cc),
//         ]
//       );
//     }
//   } catch (dbErr) {
//     console.error(`💾 DB error for ${recipientEmail}:`, dbErr.message);
//   }

//   if (sendError) throw sendError;
//   return { recipientEmail, status: sendStatus, messageId, cc: hasCc ? cc : [] };
// });

// emailQueue.on("completed", (job, result) => {
//   console.log(`✅ Job ${job.id} completed — ${result.recipientEmail} [${result.status}]`);
// });
// emailQueue.on("failed", (job, err) => {
//   console.error(`❌ Job ${job.id} failed — ${job.data.recipientEmail}: ${err.message}`);
// });

// // ─────────────────────────────────────────────
// // 8. Package endpoints (collision fixed)
// // ─────────────────────────────────────────────
// app.get("/api/seller/:id/package", async (req, res) => {
//   try {
//     const sellerId = String(req.params.id).trim();

//     const [userRows] = await pool.query(
//       `SELECT id, name, package_expire, phone_used, email_used FROM users WHERE id = ?`,
//       [sellerId]
//     );
//     if (!userRows.length) {
//       return res.status(404).json({ success: false, message: "Seller not found (local)" });
//     }
//     const user = userRows[0];

//     const [sellerRows] = await remotePool.query(
//       `SELECT id, package_id, plan_expiry_date FROM sellers WHERE id = ?`,
//       [sellerId]
//     );
//     if (!sellerRows.length) {
//       return res.status(404).json({ success: false, message: "Seller not found (remote)" });
//     }
//     const remoteSeller = sellerRows[0];
//     const planExpiryDate = remoteSeller.plan_expiry_date;
//     const isExpired = !planExpiryDate || new Date(planExpiryDate) < new Date();

//     if (!remoteSeller.package_id) {
//       return res.json({
//         success: true,
//         data: {
//           package_id: null,
//           package_name: null,
//           package_expire: user.package_expire || null,
//           plan_expiry_date: planExpiryDate || null,
//           is_expired: isExpired,
//           buyer_contact_limit: null,
//           phone_used: user.phone_used || 0,
//           email_used: user.email_used || 0,
//           phone_remaining: null,
//           email_remaining: null,
//         },
//       });
//     }

//     const [pkgRows] = await remotePool.query(
//       `SELECT id, package_name, buyer_contact_limit
//        FROM tbl_package_membership WHERE id = ?`,
//       [remoteSeller.package_id]
//     );
//     if (!pkgRows.length) {
//       return res.status(404).json({ success: false, message: "Package not found" });
//     }
//     const pkg = pkgRows[0];
//     const limit = pkg.buyer_contact_limit;
//     const isUnlimited = limit === null;
//     const phoneUsed = Number(user.phone_used || 0);
//     const emailUsed = Number(user.email_used || 0);

//     return res.json({
//       success: true,
//       data: {
//         package_id: pkg.id,
//         package_name: pkg.package_name,
//         package_expire: user.package_expire || null,
//         plan_expiry_date: planExpiryDate || null,
//         is_expired: isExpired,
//         buyer_contact_limit: limit,
//         phone_used: phoneUsed,
//         email_used: emailUsed,
//         phone_remaining: isUnlimited ? null : Math.max(limit - phoneUsed, 0),
//         email_remaining: isUnlimited ? null : Math.max(limit - emailUsed, 0),
//       },
//     });
//   } catch (err) {
//     console.error("Error fetching package info:", err);
//     return res.status(500).json({ success: false, error: err.message });
//   }
// });

// app.get("/api/package/:sellerId", async (req, res) => {
//   try {
//     const { sellerId } = req.params;

//     const [sellerRows] = await remotePool.execute(
//       "SELECT package_id FROM sellers WHERE id = ?",
//       [sellerId]
//     );
//     if (!sellerRows.length) {
//       return res.status(404).json({ success: false, message: "Seller not found" });
//     }
//     const packageId = sellerRows[0].package_id;
//     if (!packageId) {
//       return res.status(404).json({ success: false, message: "No package assigned" });
//     }

//     const [packageRows] = await remotePool.execute(
//       `SELECT id, package_name, buyer_contact_limit
//        FROM tbl_package_membership WHERE id = ?`,
//       [packageId]
//     );
//     if (!packageRows.length) {
//       return res.status(404).json({ success: false, message: "Package not found" });
//     }

//     res.json({ success: true, data: packageRows[0] });
//   } catch (err) {
//     console.error("Error fetching package:", err);
//     res.status(500).json({ success: false, message: "Internal server error", error: err.message });
//   }
// });

// // ─────────────────────────────────────────────
// // 9. Send email
// // ─────────────────────────────────────────────
// app.post("/send-email", async (req, res) => {
//   const { product, subject, message, historyPayload, seller_id, cc = [], showCc = false } = req.body;

//   console.log("═══════════════════════════════════════");
//   console.log("📧 SEND EMAIL REQUEST");
//   console.log(JSON.stringify(req.body, null, 2));

//   if (showCc && cc.length > 0) {
//     const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
//     const invalid = cc.filter((e) => !emailRegex.test(e));
//     if (invalid.length) {
//       return res.status(400).json({ error: `Invalid CC emails: ${invalid.join(", ")}` });
//     }
//     if (new Set(cc).size !== cc.length) {
//       return res.status(400).json({ error: "Duplicate CC emails found" });
//     }
//     if (cc.length > 10) {
//       return res.status(400).json({ error: "Maximum 10 CC recipients allowed" });
//     }
//   }

//   if (!seller_id) return res.status(400).json({ error: "seller_id is required" });
//   if (!historyPayload) return res.status(400).json({ error: "historyPayload is required" });

//   const { id: batchId, companies } = historyPayload;
//   if (!batchId) return res.status(400).json({ error: "historyPayload.id required" });
//   if (!companies || companies.length === 0) {
//     return res.status(400).json({ error: "No recipients specified" });
//   }

//   let emailProfile;
//   try {
//     emailProfile = await getEmailProfileBySellerId(seller_id);
//     console.log(`📨 Using profile: ${emailProfile.profile_name} (${emailProfile.sender_email})`);
//   } catch (err) {
//     return res.status(404).json({ error: err.message });
//   }

//   try {
//     const jobs = await Promise.all(
//       companies.map((company, index) =>
//         emailQueue.add(
//           {
//             recipientEmail: company.email,
//             subject,
//             message,
//             product,
//             originalProduct: company.product,
//             company: {
//               ...company,
//               buyer_id: company.buyer_id,
//               templateId: company.templateId,
//               contacts: company.contacts || company.contact_number || "",
//               contactName:
//                 company.contactName || company.contacts || company.companyName || "Unknown",
//               hsn_code: company.hsn_code || "",
//             },
//             batchId,
//             sellerId: seller_id,
//             multipleProducts: req.body.multipleProducts || false,
//             emailProfile,
//             cc: showCc ? cc : [],
//             hasCc: showCc && cc.length > 0,
//             showCc,
//           },
//           {
//             attempts: 3,
//             backoff: { type: "exponential", delay: 3000 },
//             removeOnComplete: false,
//             removeOnFail: false,
//             jobId: `${batchId}-${index}`,
//           }
//         )
//       )
//     );

//     const jobIds = jobs.map((j) => j.id.toString());
//     console.log(`Enqueued ${jobIds.length} jobs for batch ${batchId}`);

//     res.json({
//       batchId,
//       jobIds,
//       total: jobIds.length,
//       cc: showCc ? cc : [],
//       hasCc: showCc && cc.length > 0,
//       message: `Emails queued for ${companies.length} recipients${
//         showCc && cc.length > 0 ? ` with ${cc.length} CC` : ""
//       }`,
//     });
//   } catch (err) {
//     console.error("Queue error:", err);
//     res.status(500).json({ error: "Failed to enqueue jobs", details: err.message });
//   }
// });

// // ─────────────────────────────────────────────
// // 10. Batch status
// // ─────────────────────────────────────────────
// app.get("/batch-status/:batchId", async (req, res) => {
//   const { jobIds: jobIdsParam } = req.query;
//   if (!jobIdsParam) return res.status(400).json({ error: "jobIds query param required" });

//   const jobIds = jobIdsParam.split(",");

//   try {
//     const jobStatuses = await Promise.all(
//       jobIds.map(async (jobId) => {
//         const job = await emailQueue.getJob(jobId);
//         if (!job) return { jobId, state: "not_found", progress: 0, email: null };

//         const state = await job.getState();
//         return {
//           jobId,
//           email: job.data.recipientEmail,
//           companyName: job.data.company?.companyName,
//           state,
//           progress: job._progress || 0,
//           result: state === "completed" ? job.returnvalue : null,
//           reason: state === "failed" ? job.failedReason : null,
//           cc: job.data?.cc || [],
//           hasCc: job.data?.hasCc || false,
//         };
//       })
//     );

//     const total = jobStatuses.length;
//     const completed = jobStatuses.filter((j) => j.state === "completed").length;
//     const failed = jobStatuses.filter((j) => j.state === "failed").length;
//     const active = jobStatuses.filter((j) => j.state === "active").length;
//     const waiting = jobStatuses.filter((j) => ["waiting", "delayed"].includes(j.state)).length;

//     const allCc = jobStatuses.filter((j) => j.cc?.length).flatMap((j) => j.cc);
//     const uniqueCc = [...new Set(allCc)];

//     res.json({
//       batchId: req.params.batchId,
//       total,
//       completed,
//       failed,
//       active,
//       waiting,
//       allDone: completed + failed === total,
//       overallProgress: total ? Math.round(((completed + failed) / total) * 100) : 0,
//       jobs: jobStatuses,
//       hasCc: uniqueCc.length > 0,
//       ccEmails: uniqueCc,
//     });
//   } catch (err) {
//     console.error("Batch status error:", err);
//     res.status(500).json({ error: "Failed to get batch status" });
//   }
// });

// // ─────────────────────────────────────────────
// // 11. Route mounting (keep AFTER inline routes so they win)
// // ─────────────────────────────────────────────
// app.use("/", buyerRoutes);
// app.use("/", bulkBuyerRoutes);
// app.use("/", userRoutes);
// app.use("/", ssoRouter);
// app.use("/", templates);
// app.use("/", historyDetailRoutes);
// app.use("/", trackingroutes);
// app.use("/", contactroutes);
// app.use("/", emailconfigroutes);
// app.use("/", Admindashboard);
// app.use("/", searchroutes);

// // ─────────────────────────────────────────────
// // 12. Reply monitor (non-blocking)
// // ─────────────────────────────────────────────
// try {
//   const { checkForReplies } = require("./readReplies");
//   console.log("📧 Starting email reply monitor...");
//   checkForReplies().catch((e) => console.error("checkForReplies error:", e.message));
//   setInterval(() => {
//     checkForReplies().catch((e) => console.error("checkForReplies error:", e.message));
//   }, 2 * 60 * 1000);
// } catch (e) {
//   console.warn("⚠️  readReplies disabled:", e.message);
// }

// // ─────────────────────────────────────────────
// // 13. Start
// // ─────────────────────────────────────────────
// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => {
//   console.log(`🚀 Server running on port ${PORT}`);
//   console.log(`📊 Bull Board → http://localhost:${PORT}/admin/queues`);
// });