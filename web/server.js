/**
 * First National Bank Platform — Microservices Mesh & Orchestration Bootloader
 * Starts the unified API Gateway and initializes the Microservices Mesh:
 *   - Gateway: Port 3000
 *   - Microservice Mesh: Auth (3001), Documents (3002), Applications (3003), Banking (3004), Notifications (3005)
 */

const gatewayApp = require("./gateway");
const config = require("./shared/config");
const db = require("./shared/db");

const PORT = config.PORT || 3000;

const server = gatewayApp.listen(PORT, "0.0.0.0", () => {
  console.log("==========================================================");
  console.log("🏦 GRINGOTTS BANK — LIVE CORE BANKING & VAULT PLATFORM (DIAGON ALLEY)");
  console.log("==========================================================");
  console.log(`🚀 API Gateway active on: http://localhost:${PORT}`);
  console.log(`⚡ Microservices Mesh Status:`);
  console.log(`   🟢 [Auth & Mobile Identity Service]       -> Mounted at /api/v1/auth`);
  console.log(`   🟢 [Document & Base64 Vault Service]     -> Mounted at /api/v1/documents (Table: application_documents)`);
  console.log(`   🟢 [Corporate Onboarding Service]         -> Mounted at /api/v1/applications`);
  console.log(`   🟢 [Live Core Banking & FX Service]       -> Mounted at /api/v1/banking & /api/v1/mobile`);
  console.log(`   🟢 [Notification & Mailbox Service]       -> Mounted at /api/v1/notifications`);
  console.log(`🌐 Service Mesh Health Telemetry: http://localhost:${PORT}/api/v1/gateway/health`);
  console.log("==========================================================");
});

// Graceful shutdown handler
function handleShutdown(signal) {
  console.log(`\n🛑 [${signal}] Gracefully terminating First National Bank Mesh...`);
  server.close(() => {
    if (db.pool) {
      db.pool.end();
    }
    console.log("👋 Microservices cleanly disconnected.");
    process.exit(0);
  });
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

process.on("unhandledRejection", (err) => {
  console.warn("⚠️  [MESH WARNING] Unhandled promise rejection:", err && err.message ? err.message : err);
});

process.on("uncaughtException", (err) => {
  console.warn("⚠️  [MESH WARNING] Uncaught exception:", err && err.message ? err.message : err);
});


module.exports = server;
