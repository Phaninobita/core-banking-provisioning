/**
 * First National Bank API Gateway & Microservices Orchestrator (Port 3000)
 * Unified reverse proxy, rate limiter, security shield, and service mesh orchestrator.
 * Routes traffic to:
 *   - Auth Service (3001)
 *   - Document & Base64 Vault Service (3002)
 *   - Corporate Onboarding Service (3003)
 *   - Live Core Banking & FX Service (3004)
 *   - Notification & Mailbox Service (3005)
 */

const express = require("express");
const path = require("path");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const config = require("../shared/config");
const memStore = require("../shared/memStore");
const db = require("../shared/db");

// Import Microservice Routers
const authService = require("../services/auth-service");
const docService = require("../services/document-service");
const appService = require("../services/application-service");
const bankService = require("../services/banking-service");
const notifService = require("../services/notification-service");
const rmService = require("../services/rm-service");
const provisioningService = require("../services/provisioning-service");
const coreService = require("../services/core-service");

const app = express();
app.set("trust proxy", 1);

// Security & Middlewares
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "X-Mobile-Client"]
}));

// Generous payload limits for Base64 PDF and image uploads (up to 30MB)
app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true, limit: "30mb" }));

// Rate Limiters
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, default: false },
  message: { error: "Too many requests to Gateway, please try again shortly." }
});
app.use(generalLimiter);

// Gateway Telemetry Middleware
app.use((req, res, next) => {
  memStore.metrics.requestsCount++;
  memStore.metrics.serviceRequests.gateway++;
  next();
});

// ── Microservices Mesh Status & Health Registry ──
app.get("/api/v1/gateway/health", (req, res) => {
  const uptimeSeconds = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;

  res.json({
    status: "healthy",
    gateway: {
      name: "Gringotts Bank API Gateway (Diagon Alley)",
      version: "2.4.0",
      port: config.PORT,
      uptime: `${hours}h ${minutes}m ${seconds}s`,
      totalRequestsProcessed: memStore.metrics.requestsCount,
      environment: config.NODE_ENV
    },
    database: {
      status: db.isConnected() ? "connected" : "in_memory_fallback",
      engine: db.engineType === "supabase_rest"
        ? "Supabase Database (Cloud REST Engine)"
        : (db.engineType === "postgres" ? "PostgreSQL Database (TCP Pool)" : "In-Memory High-Speed Store"),
      cloudProject: "uvfdokzjdwwjpsxuuyey",
      base64VaultActive: true,
      tables: ["corporate_onboarding_applications", "application_documents", "rm_customer_invitations", "corporate_audit_logs", "corporate_accounts", "account_transactions"]
    },
    services: [
      {
        id: "auth-service",
        name: "Auth & Identity Service",
        port: config.MICROSERVICES.AUTH.port,
        status: "online",
        type: "microservice",
        requestsHandled: memStore.metrics.serviceRequests.auth,
        endpoints: ["/api/v1/auth/request-otp", "/api/v1/auth/verify-otp", "/api/v1/auth/mobile/biometric"]
      },
      {
        id: "document-service",
        name: "Document & Base64 Vault Service",
        port: config.MICROSERVICES.DOCUMENTS.port,
        status: "online",
        type: "microservice",
        requestsHandled: memStore.metrics.serviceRequests.documents,
        endpoints: ["/api/v1/documents/upload", "/api/v1/documents/list", "/api/v1/documents/download", "/api/v1/documents/ocr"]
      },
      {
        id: "application-service",
        name: "Corporate Onboarding Service",
        port: config.MICROSERVICES.APPLICATIONS.port,
        status: "online",
        type: "microservice",
        requestsHandled: memStore.metrics.serviceRequests.applications,
        endpoints: ["/api/v1/applications/current", "/api/v1/applications/save"]
      },
      {
        id: "banking-service",
        name: "Live Core Banking & FX Service",
        port: config.MICROSERVICES.BANKING.port,
        status: "online",
        type: "microservice",
        requestsHandled: memStore.metrics.serviceRequests.banking,
        endpoints: ["/api/v1/banking/accounts", "/api/v1/banking/transactions", "/api/v1/banking/fx-rates", "/api/v1/banking/transfer", "/api/v1/mobile/summary"]
      },
      {
        id: "provisioning-service",
        name: "Core Banking Provisioning Service",
        port: config.MICROSERVICES.PROVISIONING.port,
        status: "online",
        type: "microservice",
        endpoints: ["/api/v1/provisioning/provision", "/api/v1/provisioning/profile/:company_uid", "/api/v1/provisioning/cif/:company_uid", "/api/v1/provisioning/bic/:company_uid", "/api/v1/provisioning/bic/assign"]
      },
      {
        id: "core-service",
        name: "Core Banking Operations Service (Maker-Checker)",
        port: 3007,
        status: "online",
        type: "microservice",
        endpoints: ["/api/v1/core/cif", "/api/v1/core/accounts", "/api/v1/core/transactions", "/api/v1/core/requests", "/api/v1/core/requests/:ref/approve", "/api/v1/core/requests/:ref/reject", "/api/v1/core/cifs", "/api/v1/core/audit"]
      },
      {
        id: "notification-service",
        name: "Notification & Mailbox Service",
        port: config.MICROSERVICES.NOTIFICATIONS.port,
        status: "online",
        type: "microservice",
        requestsHandled: memStore.metrics.serviceRequests.notifications,
        endpoints: ["/api/v1/notifications/emails", "/api/v1/notifications/simulate", "/api/v1/notifications/push"]
      }
    ]
  });
});

// ── Microservice Routing Mounts (v1 API) ──
app.use("/api/v1/auth", authService.router);
app.use("/api/v1/documents", docService.router);
app.use("/api/v1/applications", appService.router);
app.use("/api/v1/banking", bankService.router);
app.use("/api/v1/mobile", bankService.router); // Mobile summary & quick routes
app.use("/api/v1/notifications", notifService.router);
app.use("/api/v1/rm", rmService.router);
app.use("/api/v1/provisioning", provisioningService.router);
app.use("/api/v1/core", coreService.router);

// ── Legacy Forwarding Routers (100% Backward Compatibility) ──
app.use("/api/auth", authService.router);
app.use("/api/application", appService.router);
app.use("/api/documents", docService.router);
app.use("/api/emails", notifService.router);

// Route /site, /landing, /home specifically to Gringotts Marketing & Wealth Website
app.get(["/site", "/site/", "/landing", "/landing/", "/home", "/home/"], (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "site", "index.html"));
});

// Route /rm specifically to Relationship Manager (RM) Executive Portal
app.get(["/rm", "/rm/"], (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "rm", "index.html"));
});

// Route /customer specifically to Customer Banking Portal
app.get(["/customer", "/customer/"], (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "customer", "index.html"));
});

// Route /core to the Core Banking Console (CIF, accounts & dedicated BIC provisioning)
app.get(["/core", "/core/", "/console"], (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "core", "index.html"));
});

// Static Web Assets
app.use(express.static(path.join(__dirname, "..", "public")));

// Fallback for Customer Portal SPA or root
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "API endpoint not found on Gateway." });
  }
  if (/\.(png|jpg|jpeg|gif|svg|ico|webp|css|js|map|woff|woff2|ttf|eot)$/i.test(req.path)) {
    return res.status(404).send("File not found");
  }
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

module.exports = app;
