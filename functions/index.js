const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const fetch = require("node-fetch");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");

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

// Replace onFileUploaded with onDocumentCreated
exports.onDocumentCreated = onDocumentCreated("audioProcessing/{docId}", async (event) => {
  const snap = event.data;
  const startTime = Date.now();
  logger.info("Function started at:", new Date(startTime).toISOString());

  try {
    const docData = snap.data();
    logger.info("New document created:", docData);

    // In the onDocumentCreated function, before the RunPod API call
    const runpodPayload = {
      input: {
        audio_file: docData.downloadableUrl,
        language: "en",
        initial_prompt: docData.context || "",
        batch_size: 32,
        diarization: true,
        align_output: true,
        huggingface_access_token: "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",
      },
      webhook: "https://us-central1-test-58b15.cloudfunctions.net/runpodWebhook",
      webhook_events: ["completed", "failed"],
    };

    logger.info("RunPod API request payload:", {
      endpoint: RUNPOD_ENDPOINT,
      payload: runpodPayload,
      documentData: {
        downloadableUrl: docData.downloadableUrl,
        context: docData.context,
      },
    });

    const response = await fetch(`${RUNPOD_ENDPOINT}/run`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RUNPOD_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(runpodPayload),
    });

    const result = await response.json();

    // Update the existing document with RunPod job ID and status
    await snap.ref.update({
      status: "processing",
      runpodJobId: result.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info("RunPod job submitted:", result);
  } catch (error) {
    logger.error("Error processing document:", error);

    // Update document with error status
    await snap.ref.update({
      status: "error",
      error: error.message,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    throw error;
  } finally {
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    logger.info("Function completed:", {
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      durationSeconds: duration,
    });
  }
});

// Add this helper function to process text with Gemini
const processWithGemini = async (transcript, context = "") => {
  const startTime = Date.now();
  logger.info("Gemini processing started at:", new Date(startTime).toISOString());

  try {
    logger.info("Sending request to Gemini API v1");

    // In the processWithGemini function, before the Gemini API call
    const geminiPrompt = `
      You are an AI Business Analyst assistant.

      Use the **context information** below to enhance your understanding of the transcript:

      Context/keywords:
      ${context}

      Transcript:
      ${transcript}

      Please perform the following tasks in order Use strict formatting as specified:



### 📌 Meeting Summary:
• Provide a clear, structured, professional summary.
• Focus on key discussion points, decisions made, and stakeholder contributions.
• DO NOT use "Speaker_00", "Speaker_01", etc. Deduce names if possible; if not, omit the name.
• Maintain a neutral, business-oriented tone. Do NOT hallucinate or assume.
• Keep it concise but comprehensive.
• Please do not hallucinate or assume any points. 


### ✅ Action Items:
• Format as bullet points.
 Extract only actionable statements from the transcript.
• Format clearly like this:
Name (if known): Action Description 🔧📅📝
    • If assigned to multiple people, list names.
    • If not clear, use "Unknown".
    • If it's a group task, write "Team Task".

• Action items MUST include:
    • Clear responsibility (who is doing what)
    • Verbs that show action (e.g., "schedule", "prepare", "send", "review")
    • Relevant emojis to indicate type:
    📅 (calendar/schedule),
    📝 (documentation),
    📧 (email),
    💻 (technical),
    📊 (reporting), etc.

Example Output:
    • Sarah: Prepare demo slides for Monday's client review 📝
    • Unknown: Follow up with the marketing team about campaign launch 📧
    • Team Task: Conduct usability testing before the end of the week 🧪


### 🏷️ Meeting Name:
• Generate a short, clear title summarizing the theme of the meeting.
• Add a relevant emoji.
• Make sure emoji is in the beginning of the title.
• Example: "### 🏷️ Meeting Name: • Data Integration Requirements for Nordstrom 🤝" This is wrong
• Example: "### 🏷️ Meeting Name: 🤝 Data Integration Requirements for Nordstrom" This is correct
• Example: "🔄 Quarterly Planning Sync"



### 👥 Number of People:
• Count number of unique speakers in the transcript (e.g., Speaker_00, Speaker_01, ...).
• Count will be highest number of speaker in the transcript + 1
• For example if there is SPEAKER_05, the count will be 6
• Format like this: "5"



### 🧾 Short Summary:
• Provide a **one-line summary** of the meeting.
• Be concise, direct, and meaningful.
• Example: "Team reviewed progress on the product launch and aligned on next sprint goals."



Only include exactly what is asked in the structure above. Do NOT add extra commentary, headers, or notes.`; // rest of your prompt

    logger.info("Gemini API request details:", {
      endpoint: GEMINI_URL,
      contextLength: context?.length || 0,
      transcriptLength: transcript?.length || 0,
      fullPrompt: geminiPrompt,
    });

    const response = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: geminiPrompt,
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

    // Log the raw response
    logger.info("Raw Gemini response:", {
      fullResponse: result,
      rawText: result?.candidates?.[0]?.content?.parts?.[0]?.text || "No text found",
    });

    // Validate response structure
    if (!result?.candidates?.[0]?.content?.parts?.[0]?.text) {
      logger.error("Invalid Gemini response structure:", result);
      throw new Error("Invalid Gemini API response structure");
    }

    const fullText = result.candidates[0].content.parts[0].text;

    // Log the extracted text before parsing sections
    logger.info("Extracted full text before parsing sections:", {
      fullText: fullText,
    });

    // Split all sections using markers
    const sections = {
      summary: "",
      actionItems: "",
      meetingName: "",
      numberOfPeople: "",
      shortSummary: "",
    };

    // Extract each section using the emoji markers
    // Extract Meeting Summary
    const summaryMatch = fullText.match(/### 📌 Meeting Summary:(.*?)(?=###|$)/s);
    if (summaryMatch) {
      sections.summary = summaryMatch[1].trim();
    }

    // Extract Action Items
    const actionItemsMatch = fullText.match(/### ✅ Action Items:(.*?)(?=###|$)/s);
    if (actionItemsMatch) {
      sections.actionItems = actionItemsMatch[1].trim();
    }

    // Extract Meeting Name
    const meetingNameMatch = fullText.match(/### 🏷️ Meeting Name:(.*?)(?=###|$)/s);
    if (meetingNameMatch) {
      sections.meetingName = meetingNameMatch[1].trim();
    }

    // Extract Number of People
    const numberOfPeopleMatch = fullText.match(/### 👥 Number of People:(.*?)(?=###|$)/s);
    if (numberOfPeopleMatch) {
      sections.numberOfPeople = numberOfPeopleMatch[1].trim();
    }

    // Extract Short Summary
    const shortSummaryMatch = fullText.match(/### 🧾 Short Summary:(.*?)(?=###|$)/s);
    if (shortSummaryMatch) {
      sections.shortSummary = shortSummaryMatch[1].trim();
    }

    // Log the parsed sections
    logger.info("Parsed sections:", {
      sections: sections,
    });

    logger.info("Successfully processed Gemini response and split sections");

    return {
      summary: sections.summary.trim(),
      actionItems: sections.actionItems.trim(),
      meetingName: sections.meetingName,
      numberOfPeople: sections.numberOfPeople,
      shortSummary: sections.shortSummary,
    };
  } catch (error) {
    logger.error("Gemini processing error:", {
      error: error.message,
      stack: error.stack,
    });

    return {
      summary: "Error processing transcript",
      actionItems: "Error processing action items",
      meetingName: "Error processing meeting name",
      numberOfPeople: "Error processing number of people",
      shortSummary: "Error processing short summary",
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

// Update the webhook handler to use the same document
exports.runpodWebhook = onRequest({
  cors: true,
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

    // Get the document first to access the context
    const querySnapshot = await processingCollection
        .where("runpodJobId", "==", webhookData.id)
        .limit(1)
        .get();

    if (!querySnapshot.empty) {
      const doc = querySnapshot.docs[0];
      const docData = doc.data();

      // Process with Gemini, passing both transcript and context
      const geminiResults = await processWithGemini(
          formattedTranscript,
          docData.context || "",
      );

      // Update the document with results
      await doc.ref.update({
        status: webhookData.status,
        formattedTranscript: formattedTranscript,
        summary: geminiResults.summary,
        actionItems: geminiResults.actionItems,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        error: geminiResults.error || null,
        meetingName: geminiResults.meetingName,
        numberOfPeople: geminiResults.numberOfPeople,
        shortSummary: geminiResults.shortSummary,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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
