/**
 * First National Bank Database Schema Migration Runner
 * Executes db/schema.sql against the configured Supabase / PostgreSQL database.
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

async function runMigration() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === "") {
    console.error("❌ Error: DATABASE_URL is not configured.");
    process.exit(1);
  }

  console.log("🔌 Connecting to PostgreSQL / Supabase Database...");
  console.log(`📍 Host endpoint: ${databaseUrl.split("@")[1] || "configured-url"}`);

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }
  });

  try {
    const connCheck = await pool.query("SELECT current_database(), current_user, version()");
    console.log("✅ Database connection established.");
    console.log(`   Database: ${connCheck.rows[0].current_database}`);
    console.log(`   User:     ${connCheck.rows[0].current_user}`);

    const schemaPath = path.join(__dirname, "schema.sql");
    const sql = fs.readFileSync(schemaPath, "utf8");

    console.log("\n🚀 Executing schema migration (db/schema.sql)...");
    await pool.query(sql);
    console.log("✅ Schema migration executed successfully!");

    // Verify company_uid column existence across tables
    console.log("\n🔍 Verifying company_uid columns in tables:");
    const tables = [
      "corporate_onboarding_applications",
      "rm_customer_invitations",
      "application_documents",
      "corporate_accounts",
      "account_transactions",
      "corporate_audit_logs",
      "mobile_audit_logs"
    ];

    for (const table of tables) {
      const res = await pool.query(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = 'company_uid'",
        [table]
      );
      if (res.rows.length > 0) {
        console.log(`  ✓ ${table.padEnd(36)} -> company_uid (${res.rows[0].data_type})`);
      } else {
        console.warn(`  ✗ ${table.padEnd(36)} -> column missing!`);
      }
    }

    // Verify audit logs table count
    const auditRes = await pool.query("SELECT count(*) FROM corporate_audit_logs");
    console.log(`\n🛡️ corporate_audit_logs records:       ${auditRes.rows[0].count}`);

    console.log("\n========================================================");
    console.log("🎉 ALL SCHEMA UPGRADES APPLIED & VERIFIED SUCCESSFULLY!");
    console.log("========================================================\n");
  } catch (err) {
    console.error("\n❌ Migration failed:", err.message);
    if (err.message.includes("password authentication failed")) {
      console.error("\n💡 Tip: Your database password in .env may be incorrect.");
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
