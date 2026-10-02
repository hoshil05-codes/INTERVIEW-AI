require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const mysql = require("mysql2/promise");
const { GoogleGenAI } = require("@google/genai");

// =========================
// GEMINI AI
// =========================

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

async function generateWithRetry(request, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await ai.models.generateContent(request);
    } catch (error) {
      const message = error.message || "";

      if (!message.includes("503") || attempt === retries) {
        throw error;
      }

      const wait = 2000 * Math.pow(2, attempt);

      console.log(
        `Gemini busy. Retrying in ${wait / 1000} seconds...`
      );

      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}

// =========================
// EXPRESS APP
// =========================

const app = express();
const PORT = Number(process.env.PORT) || 5000;

app.use(cors());
app.use(express.json());

// Frontend
app.use(express.static(path.join(__dirname, "frontend")));

// =========================
// UPLOADS FOLDER
// =========================

const uploadsPath = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsPath)) {
  fs.mkdirSync(uploadsPath, { recursive: true });
  console.log("Uploads folder created");
}

// =========================
// MYSQL DATABASE
// =========================

const db = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "intreviewapp",
  port: Number(process.env.DB_PORT) || 3306,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test MySQL
async function testDatabase() {
  try {
    const connection = await db.getConnection();

    await connection.query("SELECT 1");

    console.log("✅ MySQL database connected successfully");

    connection.release();

  } catch (error) {

    console.error("❌ MySQL connection failed");
    console.error("Error code:", error.code);
    console.error("Error number:", error.errno);
    console.error("SQL State:", error.sqlState);
    console.error("Error message:", error.message);
  }
}

// =========================
// MULTER AUDIO UPLOAD
// =========================

const storage = multer.diskStorage({

  destination: (req, file, cb) => {
    cb(null, uploadsPath);
  },

  filename: (req, file, cb) => {

    const extension = path.extname(file.originalname);

    const filename =
      `interview-${Date.now()}${extension}`;

    cb(null, filename);
  }
});

// Only audio files
const fileFilter = (req, file, cb) => {

  if (file.mimetype.startsWith("audio/")) {
    cb(null, true);
  } else {
    cb(
      new Error("Only audio files are allowed"),
      false
    );
  }
};

const upload = multer({

  storage,

  fileFilter,

  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

// =========================
// HEALTH CHECK
// =========================

app.get("/api/health", (req, res) => {

  res.json({
    success: true,
    message: "Interview AI backend is running"
  });

});

// =========================
// AUDIO UPLOAD API
// =========================

app.post(
  "/api/interview/upload",
  upload.single("audio"),

  (req, res) => {

    try {

      if (!req.file) {

        return res.status(400).json({
          success: false,
          message: "Please upload an audio file"
        });

      }

      console.log(
        "Audio uploaded:",
        req.file.filename
      );

      res.status(200).json({

        success: true,

        message: "Audio uploaded successfully",

        file: {
          originalName: req.file.originalname,
          filename: req.file.filename,
          mimetype: req.file.mimetype,
          size: req.file.size
        }

      });

    } catch (error) {

      console.error(
        "Upload error:",
        error
      );

      res.status(500).json({

        success: false,

        message: "Audio upload failed",

        error: error.message

      });

    }

  }
);

// =========================
// AI INTERVIEW ANALYSIS
// =========================

app.post(
  "/api/interview/analyze",

  async (req, res) => {

    try {

      // Check uploads folder
      if (!fs.existsSync(uploadsPath)) {

        return res.status(400).json({

          success: false,

          message: "Uploads folder not found."

        });

      }

      // Get files
      const files = fs.readdirSync(uploadsPath);

      if (files.length === 0) {

        return res.status(400).json({

          success: false,

          message:
            "No audio file found. Upload audio first."

        });

      }

      // Find latest file
      const latestFile = files

        .map(file => ({

          name: file,

          time: fs.statSync(
            path.join(uploadsPath, file)
          ).mtimeMs

        }))

        .sort(
          (a, b) => b.time - a.time
        )[0].name;

      const audioPath = path.join(
        uploadsPath,
        latestFile
      );

      console.log(
        "Analyzing audio:",
        latestFile
      );

      // =========================
      // UPLOAD AUDIO TO GEMINI
      // =========================

      const uploadedFile =
        await ai.files.upload({
          file: audioPath
        });

      console.log(
        "Audio uploaded to Gemini"
      );

      // =========================
      // PROMPT
      // =========================

      const prompt = `

Analyze this interview audio.

Return the result in JSON with exactly these fields:

{
  "transcript": "full interview transcript",
  "summary": "short summary",
  "positives": [
    "positive point 1",
    "positive point 2"
  ],
  "negatives": [
    "negative point 1",
    "negative point 2"
  ],
  "suggestions": [
    "suggestion 1",
    "suggestion 2"
  ]
}

Be accurate and base everything only on the audio.

Do not add markdown.
Do not add extra text outside the JSON.
Return valid JSON only.

`;

      // =========================
      // GEMINI REQUEST
      // =========================

      const response =
        await generateWithRetry({

          model: "gemini-3.8-flash",

          contents: [

            {
              text: prompt
            },

            {
              fileData: {
                fileUri: uploadedFile.uri,
                mimeType: uploadedFile.mimeType
              }
            }

          ]

        });

      console.log(
        "Gemini analysis completed"
      );

      // =========================
      // GEMINI RESPONSE
      // =========================

      let resultText = response.text;

      resultText = resultText

        .replace(
          /^```json\s*/i,
          ""
        )

        .replace(
          /^```\s*/i,
          ""
        )

        .replace(
          /\s*```$/i,
          ""
        )

        .trim();

      // Convert JSON string
      const result =
        JSON.parse(resultText);
        // =========================
// SAVE ANALYSIS TO MYSQL
// =========================

const interviewId = `INT-${Date.now()}`;
const interviewDate = new Date().toISOString().split("T")[0];

const title = "Interview Analysis";

const audioFileName = latestFile;

await db.execute(
  `INSERT INTO interviews
  (
    interview_id,
    date,
    title,
    audio_file_name,
    summary,
    positive_points,
    negative_points,
    interviewer_suggestions,
    transcript
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    interviewId,
    interviewDate,
    title,
    audioFileName,
    result.summary,
    JSON.stringify(result.positives),
    JSON.stringify(result.negatives),
    JSON.stringify(result.suggestions),
    result.transcript
  ]
);

console.log("✅ Interview analysis saved to MySQL");

      // =========================
      // SEND RESULT
      // =========================

      res.json({

        success: true,

        transcript:
          result.transcript,

        summary:
          result.summary,

        positives:
          result.positives,

        negatives:
          result.negatives,

        suggestions:
          result.suggestions

      });

    } catch (error) {

      console.error(
        "❌ Gemini analysis error:",
        error
      );

      res.status(500).json({

        success: false,

        message:
          "Gemini analysis failed",

        error:
          error.message

      });

    }

  }
);

// =========================
// START SERVER
// =========================

async function startServer() {

  await testDatabase();

  app.listen(
    PORT,

    () => {

      console.log(
        `Server running on http://localhost:${PORT}`
      );

    }

  );

}

startServer();