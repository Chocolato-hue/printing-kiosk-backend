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
      const layout = job.layout || job.options?.layout || "a5";
      console.log(`🧩 Layout mode: ${layout}`);

      // --------------------------------------------------------------------------
      // 🖼️ SINGLE A5 PHOTO (Portrait - 2:3 ratio target)
      // --------------------------------------------------------------------------
      if (layout === "a5" || layout === "fullA5") {
        console.log("🖼️ Generating single A5 photo (auto-rotate + no crop + white padding if needed)...");

        const canvasWidth = 1748;   // 14.8 cm @ 300 DPI
        const canvasHeight = 2480;  // 21.0 cm @ 300 DPI

        const metadata = await sharp(localFile).metadata();
        const ratio = metadata.width / metadata.height;
        const targetRatio = 2 / 3; // Portrait (A5 vertical)

        let imageBuffer = await sharp(localFile).toBuffer();
        let rotated = false;

        // 🔄 If the image is landscape (3:2), rotate it to portrait
        if (ratio > 1.0) {
          console.log("↩️ Rotating landscape image to portrait for A5...");
          imageBuffer = await sharp(localFile).rotate(90, { background: "white" }).toBuffer();
          rotated = true;
        }

        // Check ratio again after potential rotation
        const newMeta = await sharp(imageBuffer).metadata();
        const newRatio = newMeta.width / newMeta.height;

        let paddedImage;

        // If not close to 2:3 ratio, pad it with white
        if (Math.abs(newRatio - targetRatio) > 0.01) {
          console.log(`⚙️ Adding white padding for ratio ${newRatio.toFixed(2)} → 0.67 (2:3 target)`);

          let newWidth = newMeta.width;
          let newHeight = newMeta.height;
          if (newRatio > targetRatio) newHeight = Math.round(newMeta.width / targetRatio);
          else newWidth = Math.round(newMeta.height * targetRatio);

          const padX = Math.max(0, Math.round((newWidth - newMeta.width) / 2));
          const padY = Math.max(0, Math.round((newHeight - newMeta.height) / 2));

          paddedImage = await sharp(imageBuffer)
            .extend({
              top: padY,
              bottom: padY,
              left: padX,
              right: padX,
              background: "white",
            })
            .toBuffer();

          console.log(`🧾 Padded: ${newWidth}×${newHeight}px (added ${padX}px sides, ${padY}px top/bottom)`);
        } else {
          paddedImage = imageBuffer;
          console.log("✅ Image already near 2:3 ratio, no padding applied.");
        }

        // Resize to A5 (fit: contain ensures no crop)
        await sharp(paddedImage)
          .resize(canvasWidth, canvasHeight, { fit: "contain", background: "white" })
          .withMetadata({ icc: adobeICC, density: 300 })
          .jpeg({ quality: 95 })
          .toFile(processedFile);

        console.log(`✅ A5 photo ready (no crop, rotated=${rotated})`);

      // --------------------------------------------------------------------------
      // 🧩 TWO 4×6 PHOTOS on A5 (Landscape - 3:2 ratio target)
      // --------------------------------------------------------------------------
      } else if (layout === "two4x6") {
        console.log("🧩 Generating A5 with two 4×6 photos (auto pad, no crop, only rotate if portrait)...");

        const canvasWidth = 1748;   // 14.8 cm
        const canvasHeight = 2480;  // 21.0 cm
        const photoWidth = canvasWidth; // each photo uses full width
        const photoHeight = Math.round(photoWidth * 2 / 3); // maintain 3:2
        const tempFile = "/tmp/temp-composite.jpg";

        try {
          const metadata = await sharp(localFile).metadata();
          const ratio = metadata.width / metadata.height;
          const targetRatio = 3 / 2;

          let imageBuffer = await sharp(localFile).toBuffer();
          let rotated = false;

          // Rotate only if portrait (2:3)
          if (ratio < 1.0) {
            console.log("↩️ Rotating portrait image to landscape for 4×6...");
            imageBuffer = await sharp(localFile).rotate(90, { background: "white" }).toBuffer();
            rotated = true;
          }

          const newMeta = await sharp(imageBuffer).metadata();
          const newRatio = newMeta.width / newMeta.height;
          let paddedImage;

          // Add white padding only if not already 3:2
          if (Math.abs(newRatio - targetRatio) > 0.01) {
            console.log(`⚙️ Adding white padding for ratio ${newRatio.toFixed(2)} → 1.50 (3:2 target)`);

            let newWidth = newMeta.width;
            let newHeight = newMeta.height;
            if (newRatio > targetRatio) newHeight = Math.round(newMeta.width / targetRatio);
            else newWidth = Math.round(newMeta.height * targetRatio);

            const padX = Math.max(0, Math.round((newWidth - newMeta.width) / 2));
            const padY = Math.max(0, Math.round((newHeight - newMeta.height) / 2));

            paddedImage = await sharp(imageBuffer)
              .extend({
                top: padY,
                bottom: padY,
                left: padX,
                right: padX,
                background: "white",
              })
              .toBuffer();

            console.log(`🧾 Padded to ${newWidth}×${newHeight}px (added ${padX}px sides, ${padY}px top/bottom)`);
          } else {
            paddedImage = imageBuffer;
            console.log("✅ Image already 3:2 ratio, no padding applied.");
          }

          // Resize for 4×6 (3:2 ratio)
          const resizedPhoto = await sharp(paddedImage)
            .resize(photoWidth, photoHeight, { fit: "contain", background: "white" })
            .toBuffer();

          // Vertical stacking positions
          const totalPhotosHeight = photoHeight * 2;
          const availableSpace = canvasHeight - totalPhotosHeight;
          const gap = Math.max(1, Math.round(availableSpace / 3));
          const firstPhotoTop = gap;
          const secondPhotoTop = gap * 2 + photoHeight;

          await sharp({
            create: {
              width: canvasWidth,
              height: canvasHeight,
              channels: 3,
              background: "white",
            },
          })
            .composite([
              { input: resizedPhoto, top: firstPhotoTop, left: 0 },
              { input: resizedPhoto, top: secondPhotoTop, left: 0 },
            ])
            .withMetadata({ icc: adobeICC, density: 300 })
            .jpeg({ quality: 95 })
            .toFile(processedFile);

          console.log(`✅ Created A5 with two 4×6 photos (rotated=${rotated}, no crop)`);

        } catch (err) {
          console.error("❌ Sharp processing failed:", err.message);
          throw err;
        } finally {
          try {
            if (fs.existsSync(tempFile)) {
              fs.unlinkSync(tempFile);
              console.log("🧹 Cleaned up temp composite file.");
            }
          } catch (cleanupErr) {
            console.warn("⚠️ Failed to delete temp file:", cleanupErr.message);
          }
        }

      // --------------------------------------------------------------------------
      // 🪶 DEFAULT fallback
      // --------------------------------------------------------------------------
      } else {
        console.log("🖼️ Generating full A5 photo (default mode, no crop)...");
        await sharp(localFile)
          .resize(1748, 2480, { fit: "contain", background: "white" })
          .withMetadata({ icc: adobeICC, density: 300 })
          .jpeg({ quality: 95 })
          .toFile(processedFile);

        console.log(`✅ Full A5 image processed: ${processedFile}`);
      }

      console.log(`🎨 Image processed and converted: ${processedFile}`);
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
