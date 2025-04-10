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
• Aim for a summary that is at least 1000 characters long. 
• Adjust the level of detail based on the length and complexity of the provided transcript


### ✅ Action Items:

You are an AI Business Analyst.

Extract **only actionable statements** from the transcript. Do NOT include non-actionable comments or casual dialogue.

Format clearly using this structure:
Name (if known): Action Description 🔧📅📝  
• If assigned to multiple people, list names (e.g., Sarah & John).  
• If name is not clear, use "Unknown". Try your best to deduce the name. Dont use unknown unless you cannot deduce the name.
• If it's a group task, use "Team Task".  
• Do NOT include "Speaker_00", "Speaker_01", etc.  
• Only include actual names if they are clearly mentioned or deducible from the transcript.  
• Do NOT invent names or make assumptions.  
• Do not include casual or unclear action items. Try to make sure the action item is actionable and important.



✅ Each action item must:
- Start with the **person or team name**
- Include a **clear action verb** (e.g., review, send, schedule, write, update)
- End with a **relevant emoji**:
  📅 = Scheduling  
  📝 = Documentation  
  📧 = Email  
  💻 = Technical Task  
  📊 = Reporting  
  🧪 = Testing  
  ✅ = Completion/Checklist  
  💬 = Communication  

Example:
• Sarah: Prepare demo slides for Monday's client review 📝  
• Unknown: Follow up with the marketing team about campaign launch 📧  
• Team Task: Conduct usability testing before the end of the week 🧪  

Only return the action items. Do not return speaker numbers. Be strict about format.


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
      shortSummary: sections.shortSummary.trim(),
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

// Update the webhook handler to handle both collections
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

    // Try to find the document in both collections
    const audioProcessingQuery = await processingCollection
        .where("runpodJobId", "==", webhookData.id)
        .limit(1)
        .get();

    const lectureTranscriptsQuery = await db.collection("lectureTranscripts")
        .where("runpodJobId", "==", webhookData.id)
        .limit(1)
        .get();

    let doc;
    let isLecture = false;

    if (!audioProcessingQuery.empty) {
      doc = audioProcessingQuery.docs[0];
      isLecture = false;
    } else if (!lectureTranscriptsQuery.empty) {
      doc = lectureTranscriptsQuery.docs[0];
      isLecture = true;
    }

    if (doc) {
      const docData = doc.data();

      if (isLecture) {
        // Process lecture transcript with Gemini
        const geminiResults = await processLectureWithGemini(
            formattedTranscript,
            docData.context || "",
        );

        // Update the document with lecture results
        await doc.ref.update({
          status: webhookData.status,
          formattedTranscript: formattedTranscript,
          topicsCovered: geminiResults.topicsCovered,
          lectureNotes: geminiResults.lectureNotes,
          flashCards: geminiResults.flashCards,
          mcq: geminiResults.mcq,
          lectureTitle: geminiResults.lectureTitle,
          shortSummary: geminiResults.shortSummary,
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          error: geminiResults.error || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        // Process meeting transcript with Gemini
        const geminiResults = await processWithGemini(
            formattedTranscript,
            docData.context || "",
        );

        // Update the document with meeting results
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
    } else {
      logger.error("No matching document found for RunPod job ID:", webhookData.id);
      return res.status(404).send("Document not found");
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

// Add new function for lecture transcripts
exports.onLectureDocumentCreated = onDocumentCreated("lectureTranscripts/{docId}", async (event) => {
  const snap = event.data;
  const startTime = Date.now();
  logger.info("Lecture processing function started at:", new Date(startTime).toISOString());

  try {
    const docData = snap.data();
    logger.info("New lecture document created:", docData);

    const runpodPayload = {
      input: {
        audio_file: docData.downloadableUrl,
        language: "en",
        initial_prompt: docData.context || "",
        batch_size: 32,
        diarization: false, // Set to false for lectures
        align_output: true,
        huggingface_access_token: "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",
      },
      webhook: "https://us-central1-test-58b15.cloudfunctions.net/runpodWebhook",
      webhook_events: ["completed", "failed"],
    };

    logger.info("RunPod API request payload for lecture:", {
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

    logger.info("RunPod job submitted for lecture:", result);
  } catch (error) {
    logger.error("Error processing lecture document:", error);

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
    logger.info("Lecture processing function completed:", {
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      durationSeconds: duration,
    });
  }
});

// Add new function to process lecture content with Gemini
const processLectureWithGemini = async (transcript, context = "") => {
  const startTime = Date.now();
  logger.info("Lecture Gemini processing started at:", new Date(startTime).toISOString());

  try {
    logger.info("Sending request to Gemini API for lecture processing");

    const geminiPrompt = `
      You are a high-performing university student known for taking the clearest, most structured, and effective lecture notes and study materials.

      Use the **context information** below to enhance your understanding of the transcript:

      Context/keywords:
      ${context}

      Transcript:
      ${transcript}

      Your task is to generate accurate, beautifully formatted learning material from the lecture transcript below. Do NOT hallucinate — only use content from the transcript.

      ### 1️⃣ Topics Covered
      • Extract 8–15 major topics or concepts discussed in the lecture.  
      • Add 1 relevant emoji to each topic (e.g., 📘, 🎯, 🔬, 🧠, 🧪).  
      • Follow the order in which they appear in the lecture.  
      • Keep them short and informative.

      **Format:**
      - 📘 Topic Name
      - 🧠 Topic Name
      - 🔬 Topic Name

      ### 2️⃣ Lecture Notes 
      • Write bullet-point notes organized by topic.  
      • Use **bold** to highlight important terms.  
      • Include emojis (✅, 💡, ⚠️) to highlight key ideas, tips, or warnings.  
      • Structure content like a smart student's revision notebook.  
      • Keep tone clear, engaging, and exam-focused.

      **Example Format:**
      **📘 Topic Title**  
      • [Bullet Point] ✅  
      • [Another Important Detail] 💡  
      • [Clarification or Exception] ⚠️

      ### 3️⃣ Flashcards 
      • Generate 20 Q&A flashcards.  
      • Each card should cover one concept clearly.  
      • Keep the answers short and clear.

      **Format:**
      **Q:** [Question]  
      **A:** [Answer]

      ### 4️⃣ MCQs 
      • Create 20 multiple-choice questions from the transcript.  
      • Each question should have 3 answer options (a, b, c).  
      • Clearly indicate the correct answer as: \`✅ Correct answer: [letter]\`

      **Format:**
      **Question:**  
      [Write the question here]  
      a) Option A  
      b) Option B  
      c) Option C  
      ✅ Correct answer: b

      ### 🏷️ Lecture Title
      • Generate a short and clear title that reflects the main theme or subject of the lecture.  
      • Avoid long or overly generic names.  
      • Make it professional and concise,make sure there is a relevant emoji at begining of title e.g., "📊 Introduction to Regression Models"
      • Example: "🧠 Introduction to Neural Networks". Do not forget the emoji.
      

      ### 🧾 Short Summary
      • Provide a **strictly one-line** summary that captures the main idea of the lecture.  
      • It should explain what the lecture is about at a high level.  
      • Example: "This lecture introduces the basics of supervised machine learning techniques."

      ### ⚠️ Strict Rules:
      - ❌ DO NOT hallucinate or invent facts.
      - ❌ DO NOT include speaker numbers or references like "Speaker_01".
      - ❌ DO NOT repeat the same concepts across flashcards and MCQs.
      - ✅ Use only what's in the transcript and maintain academic tone.
      - ✅ Make content clean, structured, and ready to display in a student-facing UI.`;

    logger.info("Gemini API request details for lecture:", {
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
      logger.error("Gemini API error response for lecture:", {
        status: response.status,
        statusText: response.statusText,
        error: errorData,
      });
      throw new Error(`Gemini API error: ${errorData.error?.message || "Unknown error"}`);
    }

    const result = await response.json();
    logger.info("Received response from Gemini API for lecture");

    // Log the raw response
    logger.info("Raw Gemini response for lecture:", {
      fullResponse: result,
      rawText: result?.candidates?.[0]?.content?.parts?.[0]?.text || "No text found",
    });

    // Validate response structure
    if (!result?.candidates?.[0]?.content?.parts?.[0]?.text) {
      logger.error("Invalid Gemini response structure for lecture:", result);
      throw new Error("Invalid Gemini API response structure");
    }

    const fullText = result.candidates[0].content.parts[0].text;

    // Log the extracted text before parsing sections
    logger.info("Extracted full text before parsing lecture sections:", {
      fullText: fullText,
    });

    // Split all sections using markers
    const sections = {
      topicsCovered: "",
      lectureNotes: "",
      flashCards: "",
      mcq: "",
      lectureTitle: "",
      shortSummary: "",
    };

    // Extract each section using the markers
    const topicsMatch = fullText.match(/### 1️⃣ Topics Covered(.*?)(?=###|$)/s);
    if (topicsMatch) {
      sections.topicsCovered = topicsMatch[1].trim();
    }

    const notesMatch = fullText.match(/### 2️⃣ Lecture Notes.*?(.*?)(?=###|$)/s);
    if (notesMatch) {
      sections.lectureNotes = notesMatch[1].trim();
    }

    const flashCardsMatch = fullText.match(/### 3️⃣ Flashcards.*?(.*?)(?=###|$)/s);
    if (flashCardsMatch) {
      sections.flashCards = flashCardsMatch[1].trim();
    }

    const mcqMatch = fullText.match(/### 4️⃣ MCQs.*?(.*?)(?=###|$)/s);
    if (mcqMatch) {
      sections.mcq = mcqMatch[1].trim();
    }

    const titleMatch = fullText.match(/### 🏷️ Lecture Title(.*?)(?=###|$)/s);
    if (titleMatch) {
      sections.lectureTitle = titleMatch[1].trim();
    }

    const summaryMatch = fullText.match(/### 🧾 Short Summary(.*?)(?=###|$)/s);
    if (summaryMatch) {
      sections.shortSummary = summaryMatch[1].trim();
    }

    // Log the parsed sections
    logger.info("Parsed lecture sections:", {
      sections: sections,
    });

    logger.info("Successfully processed Gemini response and split lecture sections");

    return {
      topicsCovered: sections.topicsCovered.trim(),
      lectureNotes: sections.lectureNotes.trim(),
      flashCards: sections.flashCards.trim(),
      mcq: sections.mcq.trim(),
      lectureTitle: sections.lectureTitle.trim(),
      shortSummary: sections.shortSummary.trim(),
    };
  } catch (error) {
    logger.error("Lecture Gemini processing error:", {
      error: error.message,
      stack: error.stack,
    });

    return {
      topicsCovered: "Error processing topics",
      lectureNotes: "Error processing lecture notes",
      flashCards: "Error processing flashcards",
      mcq: "Error processing MCQs",
      lectureTitle: "Error processing lecture title",
      shortSummary: "Error processing summary",
      error: error.message,
    };
  } finally {
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    logger.info("Lecture Gemini processing completed:", {
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      durationSeconds: duration,
    });
  }
};
