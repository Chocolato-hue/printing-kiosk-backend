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
    databaseURL: "https://project01-7e159-default-rtdb.asia-southeast1.firebasedatabase.app", // ✅ replace with your actual RTDB URL
  });
}
const db = admin.firestore();
const bucket = admin.storage().bucket();
// Enable offline persistence (optional)
db.settings({ ignoreUndefinedProperties: true });

// 🔹 Register printer presence in Realtime Database (using Admin SDK)
const rtdb = admin.database();

async function registerPrinterPresence() {
  const statusRef = rtdb.ref(`status/${PRINTER_ID}`);

  await statusRef.set({
    state: "online",
    lastSeen: Date.now()
  });

  // Automatically remove this entry when Dell disconnects
  statusRef.onDisconnect().remove();

  console.log(`🟢 ${PRINTER_ID} registered in Realtime Database`);
}

registerPrinterPresence();

// 🔹 Express setup
const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/status", (req, res) => {
  res.json({ printerId: PRINTER_ID, status: "running" });
});
app.get("/rtdb-status", async (req, res) => {
  const statusRef = rtdb.ref(`status/${PRINTER_ID}`);
  res.json({ printerId: PRINTER_ID, path: statusRef.key, connected: true });
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
    const paperSize = job.paperSize ? job.paperSize.toLowerCase() : null;
    const fitOption = job.options?.fitToPage ? "-o fit-to-page" : "";
    const copiesOption = job.options?.copies ? `-n ${job.options.copies}` : "";

    const sharp = require("sharp");

    // 🔹 Convert and process image with Sharp + layout logic
    const adobeICC = "/usr/share/color/icc/AdobeRGB1998.icc";
    const convertedFile = path.join("/tmp", `converted-${Date.now()}-${job.fileName}`);
    const processedFile = path.join("/tmp", `processed-${Date.now()}-${job.fileName}`);

    try {
      const layout = job.layout || job.options?.layout || "fullA5";
      console.log(`🧩 Layout mode: ${layout}`);

      if (layout === "two4x6") {
        console.log("🧩 Generating vertical A5 with two horizontal 4×6 photos (centered horizontally)...");

        // Step 1: Resize and rotate image to landscape correctly (center rotation)
      const singleRotated = await sharp(localFile)
        .rotate(90, { background: "white" }) // first rotate
        .resize(1748, 1180, { fit: "cover" }) // then resize to proper 4×6 landscape
        .withMetadata({ icc: adobeICC })
        .toBuffer();

        // Step 2: Canvas setup
        const canvasWidth = 1748;   // A5 width
        const canvasHeight = 2480;  // A5 height
        // After rotation, the image's displayed width = original height (1748), height = original width (1180) -> WE WONT USE THIS
        // 🧮 Dynamically fit two rotated photos within A5
        const availableHeight = canvasHeight * 0.9; // leave ~10% white margins
        const rotatedHeight = availableHeight / 2;  // each photo gets half the vertical space
        const rotatedWidth = rotatedHeight * (6 / 4); // maintain 4x6 aspect ratio (landscape)

        // ✅ Center horizontally & space vertically
        const leftOffset = (canvasWidth - rotatedWidth) / 2;
        const gap = (canvasHeight - rotatedHeight * 2) / 3;

        // Step 4: Stack two horizontally rotated images vertically
        await sharp({
          create: {
            width: canvasWidth,
            height: canvasHeight,
            channels: 3,
            background: "white",
          },
        })
          .composite([
            { input: singleRotated, top: Math.round(gap), left: Math.round(leftOffset) },
            { input: singleRotated, top: Math.round(gap * 2 + rotatedHeight), left: Math.round(leftOffset) },
          ])
          .withMetadata({ icc: adobeICC, density: 300 })
          .jpeg({ quality: 95 })
          .toFile(processedFile);

        console.log(`🧩 Created A5 layout with two horizontally rotated and centered 4×6 photos: ${processedFile}`);
      } else {
        console.log("🖼️ Generating full A5 photo...");
        await sharp(localFile)
          .resize(1748, 2480, { fit: "cover" })
          .withMetadata({ icc: adobeICC, density: 300 }) // ✅ Add DPI here too
          .jpeg({ quality: 95 })
          .toFile(processedFile);
          
        console.log(`✅ Full A5 image processed: ${processedFile}`);
      }

      console.log(`🎨 Converted image to Adobe RGB + layout processed: ${processedFile}`);
    } catch (err) {
      console.error("⚠️ Sharp layout/color conversion failed, using original file instead:", err);
    }

    // 🔹 Force every print to use A5 paper
    const paperOption = "-o media=A5";
    const printCommand = `lp -d ${PRINTER_ID} ${paperOption} ${fitOption} ${copiesOption} "${processedFile || localFile}"`;

    console.log(`🖨️ Running print command: ${printCommand}`);

    await new Promise((resolve, reject) => {
      exec(printCommand, (err, stdout, stderr) => {
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

    // 4️⃣ Delete temp files safely
    if (localFile && fs.existsSync(localFile)) {
      fs.unlink(localFile, err => {
        if (err) console.warn(`⚠️ Failed to delete temp file: ${localFile}`, err);
        else console.log(`🧹 Deleted temp file: ${localFile}`);
      });
    }

    if (convertedFile && fs.existsSync(convertedFile)) {
      fs.unlink(convertedFile, err => {
        if (err) console.warn(`⚠️ Failed to delete converted file: ${convertedFile}`, err);
        else console.log(`🧹 Deleted converted file: ${convertedFile}`);
      });
    }

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
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Printer backend API running on http://localhost:${PORT}`);
});
