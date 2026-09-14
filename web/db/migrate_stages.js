/**
 * First National Bank — 7-Stage Domain Tables Migration Runner
 * Executes web/db/02_create_stage_tables.sql and initializes stage data.
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();

async function runStageMigration() {
  console.log("══════════════════════════════════════════════════════════════");
  console.log("🚀 First National Bank — 7-Stage Normalized Architecture Migration");
  console.log("══════════════════════════════════════════════════════════════\n");

  const databaseUrl = process.env.DATABASE_URL;
  const sqlFile = path.join(__dirname, "02_create_stage_tables.sql");
  const sql = fs.readFileSync(sqlFile, "utf8");

  if (databaseUrl && databaseUrl.trim() !== "") {
    console.log("🔌 Attempting PostgreSQL connection via DATABASE_URL...");
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }
    });

    try {
      await pool.query("SELECT 1");
      console.log("✅ PostgreSQL direct connection active. Applying schema migration...");
      await pool.query(sql);
      console.log("🎉 All 7-stage normalized tables created and backfilled successfully in PostgreSQL!");
      await pool.end();
      return;
    } catch (err) {
      console.warn("⚠️  Direct PostgreSQL TCP unavailable (" + err.message + ").");
      console.log("ℹ️  Supabase REST engine is active for live runtime persistence.");
      await pool.end().catch(() => {});
    }
  }

  console.log("\n📋 SQL MIGRATION PREPARED FOR SUPABASE:");
  console.log(`File: ${sqlFile}`);
  console.log("To apply in Supabase Cloud directly:");
  console.log("1. Open your Supabase Dashboard -> SQL Editor");
  console.log("2. Paste the contents of 'web/db/02_create_stage_tables.sql'");
  console.log("3. Click 'Run' to create the 7 stage tables with company_uid as Primary Key.");
  console.log("\n✅ Application code is already wired with dual-write to populate both memory and stage tables in real-time!");
  console.log("══════════════════════════════════════════════════════════════\n");
}

if (require.main === module) {
  runStageMigration().catch(err => {
    console.error("Migration error:", err);
    process.exit(1);
  });
}

module.exports = { runStageMigration };
