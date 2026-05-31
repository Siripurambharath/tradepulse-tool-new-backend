const express = require('express');
const cors = require('cors');
require('dotenv').config();
 
const { serverAdapter } = require('./Queues');
const companiesRouter  = require('./routes/Company');
const emailsRouter     = require('./routes/emailroutes');
const templatesRouter  = require('./routes/EmailTemplate');
 
const app = express();
 
app.use(cors());
app.use(express.json());
 
/* ─────────────────────────────────────────────
   ROUTES
───────────────────────────────────────────── */
 
app.use('/admin/queues', serverAdapter.getRouter());
app.use('/companies',      companiesRouter);
app.use('/',               emailsRouter);       // /send-email, /batch-status, /history
app.use('/email-templates', templatesRouter);
 
/* ─────────────────────────────────────────────
   START
───────────────────────────────────────────── */
 
app.listen(5000, () => {
  console.log('Server running on port 5000');
  console.log('Bull Board → http://localhost:5000/admin/queues');
});
 