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

    // Call RunPod API first to get the job ID
    const response = await fetch(`${RUNPOD_ENDPOINT}/run`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RUNPOD_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          audio_file: docData.downloadableUrl, // Use downloadableUrl from Firestore
          language: "en",
          initial_prompt: docData.context || "", // Use context from Firestore
          batch_size: 64,
          diarization: true,
          align_output: true,
          huggingface_access_token: "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",
        },
        webhook: "https://us-central1-test-58b15.cloudfunctions.net/runpodWebhook",
        webhook_events: ["completed", "failed"],
      }),
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

              Also, please give the meeting a name based on the transcript. Make it short and concise.
              Start the meeting name with "### Meeting Name:"
              Example: "### Meeting Name: 🤝 Integrating Salesforce and Adobe"
              Please dont forget to add an emoji to the meeting name. It should be relevant to the meeting.

              Also, please read the transcript and give me a number of people who spoke in the meeting.
              Speakers information is in the transcript will start from speaker_00 and so on.
              Start the number of people with "### Number of People:"
              Example: "### Number of People: 5 👥". This is just hardcoded example. Please give the actual number of people who spoke in the meeting.

              Please give me one line summary of the meeting. Only one line.
              Start the short summary with "### Short Summary:"
              Example: "### Short Summary: Team discussed integration plans for Salesforce and Adobe systems"
              Short summary should strictly be one liner and should be relevant to the meeting.
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

    // Split all sections using markers
    const sections = {
      summary: "",
      actionItems: "",
      meetingName: "",
      numberOfPeople: "",
      shortSummary: "",
    };

    // Extract each section using markers
    if (fullText.includes("### Action Items:")) {
      [sections.summary, sections.actionItems] = fullText.split("### Action Items:");
    }

    // Extract meeting name
    const meetingNameMatch = fullText.match(/### Meeting Name:(.*?)(?=###|$)/s);
    if (meetingNameMatch) {
      sections.meetingName = meetingNameMatch[1].trim();
    }

    // Extract number of people
    const numberOfPeopleMatch = fullText.match(/### Number of People:(.*?)(?=###|$)/s);
    if (numberOfPeopleMatch) {
      sections.numberOfPeople = numberOfPeopleMatch[1].trim();
    }

    // Extract short summary
    const shortSummaryMatch = fullText.match(/### Short Summary:(.*?)(?=###|$)/s);
    if (shortSummaryMatch) {
      sections.shortSummary = shortSummaryMatch[1].trim();
    }

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

    // Process with Gemini
    const geminiResults = await processWithGemini(formattedTranscript);

    // Update the same document with results
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
