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
        console.log("🧩 Generating A5 with two 4×6 photos (2:3 ratio, maxed to 14.8cm width)...");

        // Canvas setup - A5 vertical/portrait at 300 DPI
        const canvasWidth = 1748;   // A5 width: 14.8cm = 1748px
        const canvasHeight = 2480;  // A5 height: 21.0cm = 2480px

        // Photo dimensions - maximize width to 14.8cm, maintain 2:3 ratio
        const photoWidth = 1748;  // 14.8cm at 300dpi (full A5 width)
        const photoHeight = Math.round(photoWidth * 2 / 3);  // 2:3 ratio = 1165px ≈ 9.87cm

        console.log(`📐 Photo size: ${photoWidth}×${photoHeight}px (14.8×${(photoHeight * 2.54 / 300).toFixed(1)}cm at 300dpi)`);

        // Get original image
        const metadata = await sharp(localFile).metadata();
        console.log(`📷 Original image: ${metadata.width}×${metadata.height}`);

        // Rotate image 90° to landscape orientation
        const rotatedImage = await sharp(localFile)
          .rotate(90, { background: "white" })
          .toBuffer();

        // Resize to exact dimensions (crop to 2:3 ratio if needed)
        let resizedPhoto = await sharp(rotatedImage)
          .resize(photoWidth, photoHeight, {
            fit: "cover",  // Crop to exact 2:3 ratio
            position: "center",
            background: { r: 255, g: 255, b: 255, alpha: 1 }
          })
          .withMetadata({ icc: adobeICC })
          .toBuffer();

        // Verify resized photo dimensions match expectations
        let resizedMetadata = await sharp(resizedPhoto).metadata();
        console.log(`✓ Resized photo: ${resizedMetadata.width}×${resizedMetadata.height}px`);
        
        // Safety clamp: if Sharp added extra pixels due to rounding, scale down to exact dimensions
        if (resizedMetadata.width !== photoWidth || resizedMetadata.height !== photoHeight) {
          console.warn(`⚠️ Sharp rounding detected! Actual: ${resizedMetadata.width}×${resizedMetadata.height}, Expected: ${photoWidth}×${photoHeight}`);
          console.log(`🔧 Scaling down to exact dimensions...`);
          
          resizedPhoto = await sharp(resizedPhoto)
            .resize(photoWidth, photoHeight, {
              fit: "fill",  // Force exact dimensions by scaling
              kernel: "lanczos3"  // High-quality downscaling
            })
            .toBuffer();
          
          resizedMetadata = await sharp(resizedPhoto).metadata();
          console.log(`✓ Scaled to: ${resizedMetadata.width}×${resizedMetadata.height}px`);
        }
        
        // Final safety check: ensure photo fits in canvas
        if (resizedMetadata.width > canvasWidth || resizedMetadata.height > canvasHeight) {
          throw new Error(`Photo dimensions ${resizedMetadata.width}×${resizedMetadata.height} exceed canvas ${canvasWidth}×${canvasHeight}`);
        }

        // Calculate vertical spacing - minimal gaps
        const totalPhotosHeight = photoHeight * 2;
        const availableSpace = canvasHeight - totalPhotosHeight;
        const gap = Math.max(1, Math.round(availableSpace / 3));  // Minimum 1px gap

        const firstPhotoTop = gap;
        const secondPhotoTop = gap * 2 + photoHeight;
        
        // Safety check: ensure photos don't overflow canvas
        if (secondPhotoTop + photoHeight > canvasHeight) {
          throw new Error(`Photos overflow canvas: bottom position ${secondPhotoTop + photoHeight} exceeds ${canvasHeight}`);
        }

        console.log(`📍 Positions: photo1 top=${firstPhotoTop}px, photo2 top=${secondPhotoTop}px`);
        console.log(`📏 Vertical gaps: ${gap}px (${(gap * 2.54 / 300).toFixed(2)}cm each)`);
        console.log(`📏 Total used: ${(totalPhotosHeight * 2.54 / 300).toFixed(1)}cm of 21cm, remaining: ${(availableSpace * 2.54 / 300).toFixed(1)}cm`);

        // Create canvas and composite two photos
        await sharp({
          create: {
            width: canvasWidth,
            height: canvasHeight,
            channels: 3,
            background: "white",
          },
        })
        .composite([
          { input: resizedPhoto, top: firstPhotoTop, left: 0 },  // No horizontal offset - full width
          { input: resizedPhoto, top: secondPhotoTop, left: 0 },
        ])
        .withMetadata({ icc: adobeICC, density: 300 })
        .jpeg({ quality: 95 })
        .toFile(processedFile);

        console.log("✅ Created A5 with two 4×6 photos (14.8×9.87cm each, 2:3 ratio, minimal gaps)");
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
