/**
 * First National Bank Microservice: Notification & Mailbox Service (Port 3005)
 * Handles simulated real-time in-browser emails, real SMTP email dispatch,
 * SMS OTP verification alerts, and mobile push notification delivery.
 */

const express = require("express");
const nodemailer = require("nodemailer");
const config = require("../../shared/config");
const memStore = require("../../shared/memStore");

const router = express.Router();

const { sendYopmail } = require("./yopmailSender");

let mailTransporter = null;
if (config.SMTP.HOST && config.SMTP.USER && config.SMTP.PASS) {
  mailTransporter = nodemailer.createTransport({
    host: config.SMTP.HOST,
    port: config.SMTP.PORT,
    secure: config.SMTP.SECURE,
    auth: {
      user: config.SMTP.USER,
      pass: config.SMTP.PASS
    }
  });
  console.log("📧 [NOTIFICATION SERVICE] Real SMTP delivery active via:", config.SMTP.HOST);
}
console.log("📧 [NOTIFICATION SERVICE] Open-source Yopmail real-time delivery engine active.");


// 1. Get Simulated Emails
router.get("/emails", (req, res) => {
  memStore.metrics.serviceRequests.notifications++;
  const filterEmail = req.query.email ? req.query.email.trim().toLowerCase() : null;
  const emails = memStore.simulatedEmails;
  const results = filterEmail
    ? emails.filter(e => e.to.toLowerCase() === filterEmail || e.type === "otp")
    : emails;

  return res.json({
    success: true,
    count: results.length,
    emails: results,
    service: "notification-service"
  });
});

// 2. Clear Simulated Inbox
router.delete("/emails", (req, res) => {
  memStore.metrics.serviceRequests.notifications++;
  memStore.simulatedEmails.length = 0;
  return res.json({
    success: true,
    message: "Simulated mailbox cleared.",
    service: "notification-service"
  });
});

// 3. Manually dispatch a simulated email (DocuSign, Resume link, custom notification)
router.post("/simulate", async (req, res) => {
  memStore.metrics.serviceRequests.notifications++;
  const { to, subject, html, text, type, metadata, code } = req.body;

  const emailItem = memStore.recordSimulatedEmail({
    to: to || "admin@corporate.com",
    from: '"Gringotts Bank" <onboarding@gringotts.com>',
    subject: subject || "Gringotts Bank Corporate Update",
    html: html || "<p>Notification from Gringotts Bank (Diagon Alley)</p>",
    text: text || "Notification from Gringotts Bank (Diagon Alley)",
    code: code || null,
    type: type || "system",
    metadata: metadata || {}
  });

  // If destination is Yopmail, dispatch directly in real-time via open-source SMTP transport (if not already handled)
  if (to && to.toLowerCase().includes("yopmail") && !emailItem.metadata?.yopmailRealTime) {
    try {
      const yopmailRes = await sendYopmail({
        to,
        from: '"Gringotts Bank" <alerts@gmail.com>',
        subject: emailItem.subject,
        html: emailItem.html,
        text: emailItem.text
      });
      emailItem.metadata.yopmailRealTime = true;
      emailItem.metadata.yopmailResponse = yopmailRes.response;
      emailItem.metadata.inboxUrl = yopmailRes.inboxUrl;
    } catch (err) {
      console.log("[NOTIFICATION SERVICE] Yopmail notice:", err.message);
      emailItem.metadata.yopmailError = err.message;
    }
  } else if (mailTransporter && to) {
    try {
      await mailTransporter.sendMail({
        from: config.SMTP.FROM,
        to,
        subject: emailItem.subject,
        html: emailItem.html
      });
    } catch (err) {
      console.log("[NOTIFICATION SERVICE] SMTP notice:", err.message);
    }
  }

  return res.json({
    success: true,
    email: emailItem,
    service: "notification-service"
  });
});

// 4. Real-time Open-Source Yopmail Dispatch Endpoint
router.post("/yopmail", async (req, res) => {
  memStore.metrics.serviceRequests.notifications++;
  const { to, subject, html, text, from } = req.body;

  if (!to || !to.toLowerCase().includes("yopmail")) {
    return res.status(400).json({
      success: false,
      error: "Recipient must be a valid @yopmail.com email address",
      service: "notification-service"
    });
  }

  try {
    const result = await sendYopmail({
      to,
      from: from || '"Gringotts Bank" <alerts@gmail.com>',
      subject: subject || "Gringotts Bank Real-Time Notification",
      html,
      text
    });

    const recorded = memStore.recordSimulatedEmail({
      to,
      from: from || '"Gringotts Bank" <alerts@gmail.com>',
      subject: subject || "Gringotts Bank Real-Time Notification",
      html: html || text,
      text: text || "Real-time notification",
      type: "yopmail_realtime",
      metadata: { ...result }
    });

    return res.json({
      success: true,
      service: "notification-service",
      email: recorded,
      ...result
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
      service: "notification-service"
    });
  }
});


// 4. Mobile Push Notification Simulator
router.post("/push", (req, res) => {
  memStore.metrics.serviceRequests.notifications++;
  const { title, body, deviceToken, deepLink } = req.body;

  const pushPayload = {
    id: "push_" + Date.now(),
    title: title || "Gringotts Bank Alert",
    body: body || "Your corporate vault account has a new update.",
    deviceToken: deviceToken || "token_ios_simulator_01",
    deepLink: deepLink || "gringotts://accounts",
    deliveredAt: new Date().toISOString()
  };

  return res.json({
    success: true,
    push: pushPayload,
    service: "notification-service"
  });
});

// Health check
router.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "notification-service",
    emailsQueued: memStore.simulatedEmails.length,
    smtpConfigured: Boolean(mailTransporter),
    port: config.MICROSERVICES.NOTIFICATIONS.port,
    uptime: process.uptime()
  });
});

module.exports = { router };
