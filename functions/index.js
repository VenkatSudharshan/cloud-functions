const {onObjectFinalized} = require("firebase-functions/v2/storage");
const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const {getStorage} = require("firebase-admin/storage");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

// Initialize Firebase Admin
admin.initializeApp();

const RUNPOD_API_KEY = "rpa_WQ2BFZSBAL37B2X0PX2ICW5WXKBBTZF2OF01UGZD13g3et";
const RUNPOD_ENDPOINT = "https://api.runpod.ai/v2/hw5wd5r9tlke4r";

const GEMINI_API_KEY = "AIzaSyBvxbWvHAqA67BI-aHWQwLLRtBstYP3Y34";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

// Create a Firestore collection to store processing status
const db = admin.firestore();
const processingCollection = db.collection("audioProcessing");

// Add this helper function at the top level
const formatTime = (seconds) => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hrs.toString().padStart(2, "0")}:
  ${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
};

// Function triggered when file is uploaded
exports.onFileUploaded = onObjectFinalized({
  bucket: "test-58b15.firebasestorage.app",
  eventType: "google.storage.object.finalize",
  timeoutSeconds: 300, // 5 minutes (300 seconds)
}, async (event) => {
  const startTime = Date.now();
  logger.info("Function started at:", new Date(startTime).toISOString());

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

    // Get download URL
    const storage = getStorage();
    const bucket = storage.bucket(event.data.bucket);
    const file = bucket.file(filePath);
    const [downloadURL] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 1000 * 60 * 60, // 1 hour
    });

    logger.info("Audio file uploaded:", {
      path: filePath,
      type: contentType,
      size: fileSize,
      downloadURL: downloadURL,
    });

    // Create a document in Firestore to track processing
    const processingDoc = await processingCollection.add({
      filePath,
      status: "processing",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      downloadURL,
    });

    // Call RunPod API with webhook
    const response = await fetch(`${RUNPOD_ENDPOINT}/run`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RUNPOD_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          audio_file: downloadURL,
          language: "en",
          initial_prompt: "",
          batch_size: 32,
          diarization: true,
          align_output: true,
          huggingface_access_token: "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",
        },
        webhook: "https://us-central1-test-58b15.cloudfunctions.net/runpodWebhook",
        webhook_events: ["completed", "failed"],
      }),
    });

    const result = await response.json();

    // Update Firestore with RunPod job ID
    await processingDoc.update({
      runpodJobId: result.id,
    });

    logger.info("RunPod job submitted:", result);
  } catch (error) {
    logger.error("Error processing audio file:", error);
    throw error;
  } finally {
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000; // Convert to seconds
    logger.info("Function completed:", {
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      durationSeconds: duration,
    });
  }
});

// Add this helper function to process text with Gemini
const processWithGemini = async (transcript) => {
  const startTime = Date.now();
  logger.info("Gemini processing started at:", new Date(startTime).toISOString());

  try {
    logger.info("Sending request to Gemini API v1");

    const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `
              First Task - Meeting Summary:
              ${transcript}
              
              Please provide a detailed summary of the following transcript. Assume you are professional Business Analyst.
Summarize meeting transcript in a structured, professional format.  
The summary should be clear, concise, and formatted for stakeholders
Include key points, decisions, and main topics discussed. 
Consider the different speakers' contributions and the provided keywords for context.Consider who (which speaker) mentioned or was assigned each action item. 
Maintain a business-oriented, factual tone—no hallucination or assumptions.
Use the provided keywords for additional context. Dont give speaker_01 or speaker number back in summary
Try to deduce the speaker name from the transcript and use it in the summary once you are confident about it.
Im only passing in speaker numbers for better context dont give them back in summary. Please give names only.

              Second Task - Action Items List:
              You are an **AI-powered Business Analyst** extracting action items from a meeting transcript in a structured, professional format.  
The action items should be clear, assigned where possible, and formatted for easy tracking.

Please extract all action items from this transcript and format them as bullet points with relevant emojis. Consider who (which speaker) mentioned or was assigned each action item. Use the provided keywords for additional context. Dont give speaker_01 or speaker number back in action ietms
Try to deduce the speaker name from the transcript and use it in the action items once you are confident about it.
im only passing in speaker numbers for better context dont give them back in action items. Please give names only.


I want action items to be in format
Speaker Name: Action Item

Dont give speaker number and timestamp in action items. 
If you are not sure about the speaker name, give it as "Unknown". 
If its multi person task, give their names or if its team task, mention team task.
              Start the action items list with "### Action Items:"
            `,
          }],
        }],
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      logger.error("Gemini API error response:", {
        status: response.status,
        statusText: response.statusText,
        error: errorData,
      });
      throw new Error(`Gemini API error: ${errorData.error?.message || "Unknown error"}`);
    }

    const result = await response.json();
    logger.info("Received response from Gemini API v1");

    // Validate response structure
    if (!result?.candidates?.[0]?.content?.parts?.[0]?.text) {
      logger.error("Invalid Gemini response structure:", result);
      throw new Error("Invalid Gemini API response structure");
    }

    const fullText = result.candidates[0].content.parts[0].text;

    // Split response using the action items marker
    let [summary, actionItems] = fullText.split("### Action Items:");

    // If no split marker found, assume everything is summary
    if (!actionItems) {
      actionItems = "";
    }

    logger.info("Successfully processed Gemini response");

    return {
      summary: summary.trim(),
      actionItems: actionItems.trim(),
    };
  } catch (error) {
    logger.error("Gemini processing error:", {
      error: error.message,
      stack: error.stack,
    });

    return {
      summary: "Error processing transcript",
      actionItems: "Error processing action items",
      error: error.message,
    };
  } finally {
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    logger.info("Gemini processing completed:", {
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      durationSeconds: duration,
    });
  }
};

// Modify the webhook handler
exports.runpodWebhook = onRequest({
  cors: true, // Enable CORS for RunPod
  maxInstances: 10,
}, async (req, res) => {
  const startTime = Date.now();
  logger.info("Webhook function started at:", new Date(startTime).toISOString());

  try {
    // Validate request method
    if (req.method !== "POST") {
      logger.warn("Invalid request method:", req.method);
      return res.status(405).send("Method not allowed");
    }

    // Validate request body exists
    if (!req.body) {
      logger.error("Empty request body");
      return res.status(400).send("No request body");
    }

    const webhookData = req.body;
    logger.info("Received webhook data structure:", {
      id: webhookData.id,
      status: webhookData.status,
      hasOutput: !!webhookData.output,
      hasSegments: !!(webhookData.output && webhookData.output.segments),
    });

    // Validate webhook data structure
    if (!webhookData.id || !webhookData.status) {
      logger.error("Missing required webhook fields:", webhookData);
      return res.status(400).send("Invalid webhook data structure");
    }

    // Validate output data
    if (!webhookData.output || !Array.isArray(webhookData.output.segments)) {
      logger.error("Invalid output structure:", webhookData.output);
      return res.status(400).send("Invalid output structure");
    }

    // Format the transcript
    const formattedTranscript = webhookData.output.segments.map((segment) => {
      if (!segment) return "";
      const start = parseFloat(segment.start) || 0;
      const end = parseFloat(segment.end) || 0;
      const speaker = segment.speaker || "Unknown";
      const text = segment.text || "";
      return `[${formatTime(start)} - ${formatTime(end)}] ${speaker}:\n${text}\n`;
    }).join("\n");

    // Process with Gemini
    const geminiResults = await processWithGemini(formattedTranscript);

    // Update Firestore with formatted transcript but without raw transcript
    const querySnapshot = await processingCollection
        .where("runpodJobId", "==", webhookData.id)
        .limit(1)
        .get();

    if (!querySnapshot.empty) {
      const doc = querySnapshot.docs[0];
      await doc.ref.update({
        status: webhookData.status,
        formattedTranscript: formattedTranscript,
        summary: geminiResults.summary,
        actionItems: geminiResults.actionItems,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        error: geminiResults.error || null,
      });
    }

    return res.status(200).send("Webhook processed successfully");
  } catch (error) {
    logger.error("Webhook processing error:", error);
    return res.status(500).send("Internal server error");
  } finally {
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    logger.info("Webhook function completed:", {
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      durationSeconds: duration,
    });
  }
});
