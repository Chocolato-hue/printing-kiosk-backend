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
        console.log("🧩 Generating A5 with two 4×6 photos (bleed-safe, auto-cleanup)...");

        // --- A5 portrait at 300 DPI ---
        const canvasWidth = 1748;   // 14.8 cm
        const canvasHeight = 2480;  // 21.0 cm

        // --- Bleed settings (≈4mm per side) ---
        const bleedScale = 1.055;
        const photoWidth  = Math.round(canvasWidth * bleedScale);
        const photoHeight = Math.round(photoWidth * 2 / 3); // keep 3:2 ratio
        const leftOffset  = -Math.round((photoWidth - canvasWidth) / 2);

        console.log(`📐 Photo (bleed): ${photoWidth}×${photoHeight}px`);
        console.log(`↔️ Center offset: ${leftOffset}px`);

        // --- Oversized base canvas (to hold bleed safely) ---
        const baseWidth  = Math.round(canvasWidth  * 1.06);
        const baseHeight = Math.round(canvasHeight * 1.06);
        const cropLeft = Math.round((baseWidth  - canvasWidth) / 2);
        const cropTop  = Math.round((baseHeight - canvasHeight) / 2);

        const tempFile = "/tmp/temp-composite.jpg";

        try {
          // --- Load & rotate original ---
          const metadata = await sharp(localFile).metadata();
          console.log(`📷 Original: ${metadata.width}×${metadata.height}`);

          const rotatedImage = await sharp(localFile)
            .rotate(90, { background: "white" })
            .toBuffer();

          // --- Resize to 3:2 ratio (no distortion) ---
          let resizedPhoto = await sharp(rotatedImage)
            .resize(photoWidth, photoHeight, {
              fit: "cover",
              position: "center",
            })
            .toBuffer();

          // --- Positioning ---
          const totalPhotosHeight = photoHeight * 2;
          const availableSpace = canvasHeight - totalPhotosHeight;
          const gap = Math.max(1, Math.round(availableSpace / 3));
          const firstPhotoTop  = cropTop + gap;
          const secondPhotoTop = cropTop + gap * 2 + photoHeight;

          console.log(`📍 Positions: top1=${firstPhotoTop}, top2=${secondPhotoTop}, left=${cropLeft + leftOffset}`);
          console.log(`📏 Gap: ${(gap * 2.54 / 300).toFixed(2)} cm`);

          // --- Composite on larger base ---
          await sharp({
            create: {
              width: baseWidth,
              height: baseHeight,
              channels: 3,
              background: "white",
            },
          })
            .composite([
              { input: resizedPhoto, top: firstPhotoTop, left: cropLeft + leftOffset },
              { input: resizedPhoto, top: secondPhotoTop, left: cropLeft + leftOffset },
            ])
            .jpeg({ quality: 95 })
            .toFile(tempFile);

          // --- Crop exactly to A5 ---
          await sharp(tempFile)
            .extract({ left: cropLeft, top: cropTop, width: canvasWidth, height: canvasHeight })
            .withMetadata({ icc: adobeICC, density: 300 })
            .jpeg({ quality: 95 })
            .toFile(processedFile);

          console.log("✅ Created A5 with two 4×6 photos (bleed-safe, full coverage)");

        } catch (err) {
          console.error("❌ Sharp process failed:", err.message);
          throw err;
        } finally {
          // --- Always delete temp file after use ---
          try {
            if (fs.existsSync(tempFile)) {
              fs.unlinkSync(tempFile);
              console.log("🧹 Cleaned up temp composite file.");
            }
          } catch (cleanupErr) {
            console.warn("⚠️ Failed to delete temp file:", cleanupErr.message);
          }
        }
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
