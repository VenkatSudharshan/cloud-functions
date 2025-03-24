const {onObjectFinalized} = require("firebase-functions/v2/storage");
const logger = require("firebase-functions/logger");

exports.onFileUploaded = onObjectFinalized({
  bucket: "test-58b15.firebasestorage.app",
  eventType: "google.storage.object.finalize",
  timeoutSeconds: 300, // 5 minutes (300 seconds)
}, async (event) => {
  try {
    logger.info("Function onFileUploaded triggered successfully!");

    // Check if it's an audio file
    const contentType = event.data.contentType;
    if (!contentType.startsWith("audio/")) {
      logger.info("Not an audio file, skipping processing");
      return;
    }

    const filePath = event.data.name;
    const fileSize = event.data.size;

    logger.info("Audio file uploaded:", {
      path: filePath,
      type: contentType,
      size: fileSize,
    });

    // Add your audio processing logic here
  } catch (error) {
    logger.error("Error processing audio file:", error);
    throw error;
  }
});
