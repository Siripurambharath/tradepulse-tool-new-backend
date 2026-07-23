const XLSX = require("xlsx");
const db = require("./db");

const FILE_PATH = "./international-buyer-HS-Codes-Enriched.xlsx";

async function importExcel() {
  try {
    console.log("Starting Import...");

    const workbook = XLSX.readFile(FILE_PATH);
    const sheet = workbook.Sheets["Sheet1"];

    if (!sheet) {
      console.log("Sheet1 not found");
      return;
    }

    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    console.log("Total Rows:", rows.length);

    const today = new Date().toISOString().split("T")[0];

    let totalImported = 0;
    let totalSkippedDuplicate = 0;
    let totalSkippedNoContact = 0;

    for (const row of rows) {
      const companyName = String(row["Company Name"] || "").trim();

      if (!companyName) {
        continue;
      }

      /* DUPLICATE CHECK - by company_name only */
      const [existing] = await db.execute(
        `SELECT id FROM buyers WHERE company_name = ? LIMIT 1`,
        [companyName]
      );

      if (existing.length > 0) {
        totalSkippedDuplicate++;
        console.log(`Skipped (duplicate) -> ${companyName}`);
        continue;
      }

      const website = String(row["Website"] || "").trim();
      const country = String(row["Country"] || "").trim();
      const address = String(row["Add."] || "").trim();
      const details = String(row["Details"] || "").trim();
      const suggestedKeywords = String(row["Suggested Product Keywords"] || "").trim();
      const confidenceLevel = String(row["Confidence Level"] || "").trim();
      const reason = String(row["Reason for HS Code Selection"] || "").trim();
      const classificationNotes = String(row["Classification Notes"] || "").trim();
      const manualVerification = String(row["Manual Verification Required – Yes/No"] || "").trim();

      /* PRODUCT NAME - use Product Category; if empty/"Unclassified", fall back to Details */
      let product = String(row["Product Category"] || "").trim();
      if (!product || product.toLowerCase() === "unclassified") {
        product = details;
      }

      /* COLLECT HS CODES + DESCRIPTIONS 1-5 */
      const hsCodes = [];
      const hsDescriptions = [];

      for (let i = 1; i <= 5; i++) {
        const codeKey = i === 1 ? "HS Code 1 – Most Likely" : `HS Code ${i}`;
        const descKey = `HS Code ${i} Description`;

        const codeVal = String(row[codeKey] || "").trim();
        const descVal = String(row[descKey] || "").trim();

        if (codeVal) hsCodes.push(codeVal);
        if (descVal) hsDescriptions.push(descVal);
      }

      const hsnCode = hsCodes.join(" / ");
      const hsnDescriptions = hsDescriptions.join(" / ");

      /* CONTACTS */
      const contacts = String(row["Contact No. "] || "")
        .replace(/Telephone|Phone|Mobile|Tel:|Fax:/gi, "")
        .split(/\n|\/|,/)
        .map((x) => x.trim())
        .filter(Boolean);

      /* EMAILS - drop any @example.com addresses */
      const emails = String(row["Email Ids."] || "")
        .replace(/Email:/gi, "")
        .split(/\n|\/|,|;/)
        .map((x) => x.trim())
        .filter(Boolean)
        .filter((e) => !e.toLowerCase().includes("@example.com"));

      /* SKIP ROW - if there is no contact number AND no email left */
      if (contacts.length === 0 && emails.length === 0) {
        totalSkippedNoContact++;
        console.log(`Skipped (no contact/email) -> ${companyName}`);
        continue;
      }

      /* INSERT BUYER */
      const [buyerResult] = await db.execute(
        `INSERT INTO buyers
        (product, hsn_code, country, company_name, website, buyer_date,
         address, details, suggested_keywords, hsn_descriptions,
         confidence_level, reason, classification_notes, manual_verification)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          product,
          hsnCode,
          country,
          companyName,
          website,
          today,
          address,
          details,
          suggestedKeywords,
          hsnDescriptions,
          confidenceLevel,
          reason,
          classificationNotes,
          manualVerification
        ]
      );

      const buyerId = buyerResult.insertId;

      for (const contact of contacts) {
        await db.execute(
          `INSERT INTO buyer_contacts (buyer_id, contact_number) VALUES (?,?)`,
          [buyerId, contact]
        );
      }

      for (const email of emails) {
        await db.execute(
          `INSERT INTO buyer_emails (buyer_id, email) VALUES (?,?)`,
          [buyerId, email]
        );
      }

      totalImported++;
      console.log(`${totalImported}. Imported -> ${companyName}`);
    }

    console.log("================================");
    console.log("Import Completed");
    console.log("Total Imported:", totalImported);
    console.log("Total Skipped (duplicates):", totalSkippedDuplicate);
    console.log("Total Skipped (no contact/email):", totalSkippedNoContact);

    await db.end();
  } catch (err) {
    console.error("IMPORT ERROR:");
    console.error(err);
  }
}

importExcel();