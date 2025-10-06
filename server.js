require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

// 🔑 Printer ID
const PRINTER_ID = process.env.PRINTER_ID;
if (!PRINTER_ID) {
  console.error("❌ ERROR: PRINTER_ID is not set in .env");
  process.exit(1);
}
console.log(`🖨️ Printer backend starting for: ${PRINTER_ID}`);

// 🔹 Firebase Admin SDK
const serviceAccount = require("./firebase-service-account.json");
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}
const db = admin.firestore();
const bucket = admin.storage().bucket();

// Enable offline persistence (optional)
db.settings({ ignoreUndefinedProperties: true });

// 🔹 Express setup
const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/status", (req, res) => {
  res.json({ printerId: PRINTER_ID, status: "running" });
});

// 🔹 Process a single print job
async function processJob(doc) {
  const job = doc.data();
  const jobId = doc.id;
  const localFile = path.join("/tmp", `${Date.now()}-${job.fileName}`);

  console.log(`📥 Processing job ${jobId}`, job);

  try {
    // 1️⃣ Download file from Firebase Storage
    const remoteFilePath = `printJobs/${job.fileName}`;
    await bucket.file(remoteFilePath).download({ destination: localFile });
    console.log(`✅ File downloaded to ${localFile}`);

    // 2️⃣ Send to printer
    await new Promise((resolve, reject) => {
      exec(`lp -d ${PRINTER_ID} "${localFile}"`, (err, stdout, stderr) => {
        if (err) return reject(stderr || err);
        console.log(`[${PRINTER_ID}] Print output:`, stdout);
        resolve();
      });
    });

    // 3️⃣ Update Firestore job status
    await db.collection("printJobs").doc(jobId).update({
      status: "completed",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`✅ Job ${jobId} completed.`);

    // 4️⃣ Delete temp file
    fs.unlink(localFile, err => {
      if (err) console.warn(`⚠️ Failed to delete temp file: ${localFile}`, err);
      else console.log(`🧹 Deleted temp file: ${localFile}`);
    });

    // 5️⃣ Delete file from Firebase Storage
    await bucket.file(remoteFilePath).delete();
    console.log(`🗑️ Deleted file from Firebase Storage: ${remoteFilePath}`);

  } catch (err) {
    const errorMsg = err?.message || err?.toString() || "Unknown error";
    console.error(`❌ Job ${jobId} failed:`, errorMsg);

    await db.collection("printJobs").doc(jobId).update({
      status: "failed",
      error: errorMsg,
    });
  }
}

// 🔹 Listen for new pending jobs in real-time
db.collection("printJobs")
  .where("printerId", "==", PRINTER_ID)
  .where("status", "==", "pending")
  .onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
      if (change.type === "added") {
        processJob(change.doc);
      }
    });
  }, err => {
    console.error(`[${PRINTER_ID}] Firestore listener error:`, err);
  });

// 🔹 Start Express server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Printer backend API running on http://localhost:${PORT}`);
});
