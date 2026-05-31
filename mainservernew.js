const XLSX = require("xlsx");
const db = require("./db");

const FILE_PATH =
  "./Buyer Data with Contact Details new.xlsx";

async function importExcel() {
  try {
    console.log("Starting Import...");

    const workbook = XLSX.readFile(FILE_PATH);

    const sheetName = workbook.SheetNames.find(
      (s) => s.trim() === "Data Working"
    );

    if (!sheetName) {
      console.log(
        "Data Working sheet not found"
      );
      return;
    }

    console.log(
      "Processing Sheet:",
      sheetName
    );

    const sheet =
      workbook.Sheets[sheetName];

    const rows =
      XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: ""
      });

    console.log(
      "Total Rows:",
      rows.length
    );

    let currentDate = null;
    let currentProduct = null;
    let totalImported = 0;

    for (const row of rows) {
      if (!Array.isArray(row)) continue;

      /* DATE ROW */
      if (
        row[0] &&
        typeof row[0] === "string" &&
        /^\d{2}\.\d{2}\.\d{4}$/.test(
          row[0].trim()
        )
      ) {
        const [dd, mm, yyyy] =
          row[0].trim().split(".");

        currentDate =
          `${yyyy}-${mm}-${dd}`;

        console.log(
          "Date Found:",
          currentDate
        );

        continue;
      }

      /* PRODUCT HEADER ROW */
      if (
        row[0] &&
        String(row[2]).trim() === "Sr No"
      ) {
        currentProduct =
          String(row[0]).trim();

        console.log(
          "Product Found:",
          currentProduct
        );

        continue;
      }

      /* FIRST ROW OF PRODUCT SECTION */
      if (
        row[0] &&
        row[1] &&
        !isNaN(Number(row[2]))
      ) {
        currentProduct =
          String(row[0]).trim();
      }

      /* DATA ROW */
      if (
        row[2] !== "" &&
        !isNaN(Number(row[2]))
      ) {
        const hsnCode = String(
          row[1] || ""
        ).trim();

        const country = String(
          row[3] || ""
        ).trim();

        const companyName = String(
          row[4] || ""
        ).trim();

        const contactData = String(
          row[5] || ""
        ).trim();

        const col6 = String(
          row[6] || ""
        ).trim();

        const col7 = String(
          row[7] || ""
        ).trim();

        let website = "";
        let emailData = "";

        if (col6.includes("@")) {
          emailData = col6;
          website = col7;
        } else if (col7.includes("@")) {
          emailData = col7;
          website = col6;
        } else {
          website = col6;
        }

        if (!companyName) {
          console.log(
            "Skipping row - company missing",
            row
          );
          continue;
        }

        const [buyerResult] =
          await db.execute(
            `
            INSERT INTO buyers
            (
              buyer_date,
              product,
              hsn_code,
              country,
              company_name,
              website
            )
            VALUES
            (?,?,?,?,?,?)
            `,
            [
              currentDate,
              currentProduct,
              hsnCode,
              country,
              companyName,
              website
            ]
          );

        const buyerId =
          buyerResult.insertId;

        /* CONTACTS */

        const contacts =
          contactData
            .replace(
              /Telephone|Phone|Mobile|Tel:|Fax:/gi,
              ""
            )
            .split(
              /\n|\/|,/
            )
            .map((x) => x.trim())
            .filter(Boolean);

        for (const contact of contacts) {
          await db.execute(
            `
            INSERT INTO buyer_contacts
            (
              buyer_id,
              contact_number
            )
            VALUES (?,?)
            `,
            [
              buyerId,
              contact
            ]
          );
        }

        /* EMAILS */

        const emails =
          emailData
            .replace(
              /Email:/gi,
              ""
            )
            .split(
              /\n|\/|,|;/
            )
            .map((x) => x.trim())
            .filter(Boolean);

        for (const email of emails) {
          await db.execute(
            `
            INSERT INTO buyer_emails
            (
              buyer_id,
              email
            )
            VALUES (?,?)
            `,
            [
              buyerId,
              email
            ]
          );
        }

        totalImported++;

        console.log(
          `${totalImported}. Imported -> ${companyName}`
        );
      }
    }

    console.log(
      "================================"
    );

    console.log(
      "Import Completed"
    );

    console.log(
      "Total Imported:",
      totalImported
    );

    await db.end();
  } catch (err) {
    console.error(
      "IMPORT ERROR:"
    );
    console.error(err);
  }
}

importExcel();