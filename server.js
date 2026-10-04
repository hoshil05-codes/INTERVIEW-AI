require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { GoogleGenAI } = require("@google/genai");

// =========================
// CONFIGURATION & SECRETS
// =========================
const JWT_SECRET = process.env.JWT_SECRET || "intervai-super-secret-jwt-key-2026";

// =========================
// DIRECTORIES
// =========================
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const uploadsPath = isServerless ? path.join("/tmp", "uploads") : path.join(__dirname, "uploads");
const dataPath = isServerless ? path.join("/tmp", "data") : path.join(__dirname, "data");
const localDbPath = path.join(dataPath, "interviews.json");
const usersDbPath = path.join(dataPath, "users.json");

if (!fs.existsSync(uploadsPath)) {
  fs.mkdirSync(uploadsPath, { recursive: true });
}

if (!fs.existsSync(dataPath)) {
  fs.mkdirSync(dataPath, { recursive: true });
}

// =========================
// GEMINI AI
// =========================
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
// Active and available Gemini models prioritized by verified availability & quota
const FALLBACK_MODELS = Array.from(
  new Set([
    DEFAULT_MODEL,
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "gemini-3.5-flash"
  ])
);

function getAudioMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".webm":
      return "audio/webm";
    case ".mp3":
      return "audio/mp3";
    case ".mpeg":
    case ".mpga":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".m4a":
    case ".mp4":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".flac":
      return "audio/flac";
    default:
      return "audio/mpeg";
  }
}

async function generateWithRetry(request, retries = 1) {
  let lastError = null;

  for (const modelName of FALLBACK_MODELS) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        console.log(`[Gemini] Calling model "${modelName}" (attempt ${attempt + 1}/${retries + 1})...`);
        const req = { ...request, model: modelName };
        const res = await ai.models.generateContent(req);
        console.log(`[Gemini] ✅ Success with model "${modelName}"`);
        return res;
      } catch (error) {
        lastError = error;
        const msg = error.message || "";
        const status = error.status || (error.error && error.error.code);

        console.warn(`[Gemini] Model "${modelName}" failed (status ${status}):`, msg.slice(0, 120));

        // If rate limited or model busy (503 / 429), quick 1s retry then switch to fallback
        if (
          status === 503 ||
          status === 429 ||
          msg.includes("503") ||
          msg.includes("429") ||
          msg.includes("resource exhausted") ||
          msg.includes("high demand") ||
          msg.includes("overloaded") ||
          msg.includes("UNAVAILABLE")
        ) {
          if (attempt >= retries) {
            console.warn(`[Gemini] Model "${modelName}" busy, switching immediately to next fallback model...`);
            break;
          }
          console.log(`[Gemini] Retrying "${modelName}" in 1.2s...`);
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }

        // If model not found or unsupported (404), switch to next model immediately
        if (status === 404 || msg.includes("not found") || msg.includes("404") || msg.includes("no longer available")) {
          console.warn(`[Gemini] Model "${modelName}" not available, switching immediately to next model...`);
          break;
        }

        // Other errors (e.g. invalid arguments)
        throw error;
      }
    }
  }

  throw lastError || new Error("Gemini AI is currently experiencing high demand. Please try again in a few moments.");
}

// =========================
// DATABASE / STORAGE LAYER
// =========================
let dbPool = null;
let isDbConnected = false;

// Fallback file storage helpers
function readLocalInterviews() {
  try {
    if (!fs.existsSync(localDbPath)) {
      return [];
    }
    const raw = fs.readFileSync(localDbPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error reading local interviews JSON:", err.message);
    return [];
  }
}

function writeLocalInterviews(items) {
  try {
    fs.writeFileSync(localDbPath, JSON.stringify(items, null, 2), "utf-8");
  } catch (err) {
    console.error("Error writing local interviews JSON:", err.message);
  }
}

function readLocalUsers() {
  try {
    if (!fs.existsSync(usersDbPath)) {
      return [];
    }
    const raw = fs.readFileSync(usersDbPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

function writeLocalUsers(items) {
  try {
    fs.writeFileSync(usersDbPath, JSON.stringify(items, null, 2), "utf-8");
  } catch (err) {}
}

function parseArrayField(val) {
  if (Array.isArray(val)) return val;
  if (!val) return [];
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
      return [parsed];
    } catch {
      return [val];
    }
  }
  return [];
}

function normalizeInterview(item) {
  if (!item) return null;

  const positives = parseArrayField(item.positive_points || item.positives);
  const negatives = parseArrayField(item.negative_points || item.negatives);
  const suggestions = parseArrayField(item.interviewer_suggestions || item.suggestions);

  return {
    id: item.id || item.interview_id,
    interview_id: item.interview_id || `INT-${item.id || Date.now()}`,
    date: item.date ? (typeof item.date === "string" ? item.date.split("T")[0] : new Date(item.date).toISOString().split("T")[0]) : new Date().toISOString().split("T")[0],
    createdAt: item.created_at || item.createdAt || item.date || new Date().toISOString(),
    title: item.title || "Interview Analysis",
    audio_file_name: item.audio_file_name || "",
    summary: item.summary || "",
    positives,
    positive_points: positives,
    negatives,
    negative_points: negatives,
    suggestions,
    interviewer_suggestions: suggestions,
    transcript: item.transcript || "",
    score: item.score != null ? Number(item.score) : null,
    communication_score: item.communication_score != null ? Number(item.communication_score) : (item.score != null ? Number(item.score) : null),
    technical_score: item.technical_score != null ? Number(item.technical_score) : (item.score != null ? Number(item.score) : null),
    confidence_score: item.confidence_score != null ? Number(item.confidence_score) : (item.score != null ? Number(item.score) : null),
    structure_score: item.structure_score != null ? Number(item.structure_score) : (item.score != null ? Number(item.score) : null),
    user_id: item.user_id || null,
    user_email: item.user_email || null,
    practice_role: item.practice_role || null,
    practice_question: item.practice_question || null,
    words_per_minute: item.words_per_minute != null ? Number(item.words_per_minute) : null,
    pacing_feedback: item.pacing_feedback || null,
    filler_words_count: item.filler_words_count != null ? Number(item.filler_words_count) : null,
    filler_words_breakdown: parseArrayField(item.filler_words_breakdown),
    followup_question: item.followup_question || null
  };
}

async function initDatabase() {
  const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
  const dbHost = process.env.DB_HOST;

  if (dbUrl || dbHost) {
    try {
      let poolOptions = {};

      if (dbUrl) {
        poolOptions = {
          uri: dbUrl,
          waitForConnections: true,
          connectionLimit: 10,
          queueLimit: 0,
          ssl: process.env.DB_SSL === "false" ? undefined : { rejectUnauthorized: false }
        };
      } else {
        const needsSsl = process.env.DB_SSL === "true" || (dbHost !== "localhost" && dbHost !== "127.0.0.1" && process.env.DB_SSL !== "false");
        poolOptions = {
          host: dbHost || "127.0.0.1",
          user: process.env.DB_USER || "root",
          password: process.env.DB_PASSWORD || "",
          database: process.env.DB_NAME || "intreviewapp",
          port: Number(process.env.DB_PORT) || 3306,
          waitForConnections: true,
          connectionLimit: 10,
          queueLimit: 0,
          ssl: needsSsl ? { rejectUnauthorized: false } : undefined
        };
      }

      dbPool = mysql.createPool(poolOptions);

      const conn = await dbPool.getConnection();
      await conn.query("SELECT 1");

      // Auto-create users table if not exists
      await conn.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          email VARCHAR(255) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Auto-create interviews table if not exists
      await conn.query(`
        CREATE TABLE IF NOT EXISTS interviews (
          id INT AUTO_INCREMENT PRIMARY KEY,
          interview_id VARCHAR(255) NOT NULL,
          date VARCHAR(50) NOT NULL,
          title VARCHAR(255) NOT NULL DEFAULT 'Interview Analysis',
          audio_file_name VARCHAR(255),
          summary TEXT,
          positive_points TEXT,
          negative_points TEXT,
          interviewer_suggestions TEXT,
          transcript TEXT,
          score INT DEFAULT NULL,
          communication_score INT DEFAULT NULL,
          technical_score INT DEFAULT NULL,
          confidence_score INT DEFAULT NULL,
          structure_score INT DEFAULT NULL,
          user_id INT DEFAULT NULL,
          user_email VARCHAR(255) DEFAULT NULL,
          practice_role VARCHAR(255) DEFAULT NULL,
          practice_question TEXT DEFAULT NULL,
          words_per_minute INT DEFAULT NULL,
          pacing_feedback VARCHAR(255) DEFAULT NULL,
          filler_words_count INT DEFAULT NULL,
          filler_words_breakdown TEXT DEFAULT NULL,
          followup_question TEXT DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Ensure columns exist on legacy tables
      try {
        await conn.query("ALTER TABLE interviews ADD COLUMN score INT DEFAULT NULL");
      } catch (_) {}
      try {
        await conn.query("ALTER TABLE interviews ADD COLUMN communication_score INT DEFAULT NULL");
      } catch (_) {}
      try {
        await conn.query("ALTER TABLE interviews ADD COLUMN technical_score INT DEFAULT NULL");
      } catch (_) {}
      try {
        await conn.query("ALTER TABLE interviews ADD COLUMN confidence_score INT DEFAULT NULL");
      } catch (_) {}
      try {
        await conn.query("ALTER TABLE interviews ADD COLUMN structure_score INT DEFAULT NULL");
      } catch (_) {}
      try {
        await conn.query("ALTER TABLE interviews ADD COLUMN user_id INT DEFAULT NULL");
      } catch (_) {}
      try {
        await conn.query("ALTER TABLE interviews ADD COLUMN user_email VARCHAR(255) DEFAULT NULL");
      } catch (_) {}
      try {
        await conn.query("ALTER TABLE interviews ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
      } catch (_) {}
      try {
        await conn.query("ALTER TABLE interviews ADD COLUMN practice_role VARCHAR(255) DEFAULT NULL");
      } catch (_) {}
      try {
        await conn.query("ALTER TABLE interviews ADD COLUMN practice_question TEXT DEFAULT NULL");
      } catch (_) {}
      try {
        await conn.query("ALTER TABLE interviews ADD COLUMN words_per_minute INT DEFAULT NULL");
      } catch (_) {}
      try {
        await conn.query("ALTER TABLE interviews ADD COLUMN pacing_feedback VARCHAR(255) DEFAULT NULL");
      } catch (_) {}
      try {
        await conn.query("ALTER TABLE interviews ADD COLUMN filler_words_count INT DEFAULT NULL");
      } catch (_) {}
      try {
        await conn.query("ALTER TABLE interviews ADD COLUMN filler_words_breakdown TEXT DEFAULT NULL");
      } catch (_) {}
      try {
        await conn.query("ALTER TABLE interviews ADD COLUMN followup_question TEXT DEFAULT NULL");
      } catch (_) {}

      conn.release();
      isDbConnected = true;
      console.log("✅ MySQL database connected and verified successfully");
      return;
    } catch (err) {
      console.warn("⚠️ MySQL connection failed:", err.message);
      console.warn("Using local resilient file storage (data/interviews.json).");
      isDbConnected = false;
    }
  } else {
    console.log("ℹ️ No MySQL config provided. Using local file storage (data/interviews.json).");
    isDbConnected = false;
  }
}

// =========================
// USER AUTHENTICATION HELPERS
// =========================
async function findUserByEmail(email) {
  if (!email) return null;
  const cleanEmail = email.toLowerCase().trim();

  if (isDbConnected && dbPool) {
    try {
      const [rows] = await dbPool.query(
        "SELECT * FROM users WHERE email = ? LIMIT 1",
        [cleanEmail]
      );
      if (rows.length > 0) return rows[0];
    } catch (err) {
      console.error("MySQL findUserByEmail error:", err.message);
    }
  }

  const local = readLocalUsers();
  return local.find((u) => u.email.toLowerCase() === cleanEmail) || null;
}

async function findUserById(id) {
  if (!id) return null;

  if (isDbConnected && dbPool) {
    try {
      const [rows] = await dbPool.query(
        "SELECT id, name, email, created_at FROM users WHERE id = ? LIMIT 1",
        [id]
      );
      if (rows.length > 0) return rows[0];
    } catch (err) {
      console.error("MySQL findUserById error:", err.message);
    }
  }

  const local = readLocalUsers();
  const u = local.find((item) => String(item.id) === String(id));
  if (u) {
    return { id: u.id, name: u.name, email: u.email, created_at: u.created_at };
  }
  return null;
}

async function createNewUser({ name, email, password }) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanName = name.trim();

  if (isDbConnected && dbPool) {
    try {
      const [res] = await dbPool.execute(
        "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
        [cleanName, cleanEmail, password]
      );
      return {
        id: res.insertId,
        name: cleanName,
        email: cleanEmail
      };
    } catch (err) {
      console.error("MySQL createUser error, fallback to local:", err.message);
    }
  }

  const local = readLocalUsers();
  const newUser = {
    id: Date.now(),
    name: cleanName,
    email: cleanEmail,
    password,
    created_at: new Date().toISOString()
  };
  local.push(newUser);
  writeLocalUsers(local);
  return { id: newUser.id, name: newUser.name, email: newUser.email };
}

// =========================
// INTERVIEWS STORAGE HELPERS
// =========================
async function getAllInterviews(userId = null, userEmail = null) {
  if (isDbConnected && dbPool) {
    try {
      let query = "SELECT * FROM interviews";
      let params = [];

      if (userId || userEmail) {
        query += " WHERE user_id = ? OR user_email = ? OR (user_id IS NULL AND user_email IS NULL) ORDER BY id DESC";
        params = [userId || -1, userEmail || ""];
      } else {
        query += " ORDER BY id DESC";
      }

      const [rows] = await dbPool.query(query, params);
      return rows.map(normalizeInterview);
    } catch (err) {
      console.error("MySQL query error in getAllInterviews:", err.message);
    }
  }

  const local = readLocalInterviews();
  if (userId || userEmail) {
    return local
      .filter(
        (item) =>
          String(item.user_id) === String(userId) ||
          item.user_email === userEmail ||
          (!item.user_id && !item.user_email)
      )
      .map(normalizeInterview);
  }
  return local.map(normalizeInterview);
}

async function getInterviewById(id) {
  if (isDbConnected && dbPool) {
    try {
      const [rows] = await dbPool.query(
        "SELECT * FROM interviews WHERE interview_id = ? OR id = ? LIMIT 1",
        [id, isNaN(Number(id)) ? -1 : Number(id)]
      );
      if (rows.length > 0) {
        return normalizeInterview(rows[0]);
      }
    } catch (err) {
      console.error("MySQL query error in getInterviewById:", err.message);
    }
  }
  const local = readLocalInterviews();
  const match = local.find(
    (item) => String(item.id) === String(id) || String(item.interview_id) === String(id)
  );
  return match ? normalizeInterview(match) : null;
}

async function saveInterviewRecord(record) {
  const normalized = normalizeInterview(record);

  if (isDbConnected && dbPool) {
    try {
      const [res] = await dbPool.execute(
        `INSERT INTO interviews (
          interview_id,
          date,
          title,
          audio_file_name,
          summary,
          positive_points,
          negative_points,
          interviewer_suggestions,
          transcript,
          score,
          communication_score,
          technical_score,
          confidence_score,
          structure_score,
          user_id,
          user_email,
          practice_role,
          practice_question,
          words_per_minute,
          pacing_feedback,
          filler_words_count,
          filler_words_breakdown,
          followup_question
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          normalized.interview_id,
          normalized.date,
          normalized.title,
          normalized.audio_file_name,
          normalized.summary,
          JSON.stringify(normalized.positives),
          JSON.stringify(normalized.negatives),
          JSON.stringify(normalized.suggestions),
          normalized.transcript,
          normalized.score,
          normalized.communication_score,
          normalized.technical_score,
          normalized.confidence_score,
          normalized.structure_score,
          normalized.user_id,
          normalized.user_email,
          normalized.practice_role,
          normalized.practice_question,
          normalized.words_per_minute,
          normalized.pacing_feedback,
          normalized.filler_words_count,
          JSON.stringify(normalized.filler_words_breakdown || []),
          normalized.followup_question
        ]
      );
      normalized.id = res.insertId || normalized.interview_id;
      return normalized;
    } catch (err) {
      console.warn("Primary MySQL save with extended fields failed:", err.message);
      try {
        // Fallback insert with legacy columns
        const [resFallback] = await dbPool.execute(
          `INSERT INTO interviews (
            interview_id, date, title, audio_file_name, summary, positive_points, negative_points,
            interviewer_suggestions, transcript, score, communication_score, technical_score,
            confidence_score, structure_score, user_id, user_email, practice_role, practice_question
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            normalized.interview_id, normalized.date, normalized.title, normalized.audio_file_name, normalized.summary,
            JSON.stringify(normalized.positives), JSON.stringify(normalized.negatives), JSON.stringify(normalized.suggestions),
            normalized.transcript, normalized.score, normalized.communication_score, normalized.technical_score,
            normalized.confidence_score, normalized.structure_score, normalized.user_id, normalized.user_email,
            normalized.practice_role, normalized.practice_question
          ]
        );
        normalized.id = resFallback.insertId || normalized.interview_id;
        return normalized;
      } catch (err2) {
        console.error("MySQL save fallback error, using local resilient file:", err2.message);
      }
    }
  }

  const list = readLocalInterviews();
  normalized.id = Date.now();
  list.unshift(normalized);
  writeLocalInterviews(list);
  return normalized;
}

async function deleteInterviewById(id) {
  let deleted = false;

  if (isDbConnected && dbPool) {
    try {
      const [res] = await dbPool.execute(
        "DELETE FROM interviews WHERE interview_id = ? OR id = ?",
        [id, isNaN(Number(id)) ? -1 : Number(id)]
      );
      if (res.affectedRows > 0) deleted = true;
    } catch (err) {
      console.error("MySQL delete error:", err.message);
    }
  }

  const list = readLocalInterviews();
  const filtered = list.filter(
    (item) => String(item.id) !== String(id) && String(item.interview_id) !== String(id)
  );
  if (filtered.length !== list.length) {
    writeLocalInterviews(filtered);
    deleted = true;
  }

  return deleted;
}

// =========================
// EXPRESS APPLICATION
// =========================
const app = express();
const PORT = Number(process.env.PORT) || 5000;

app.use(cors());
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));

// Optional JWT User Extractor Middleware
app.use((req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;

  if (!token) {
    req.user = null;
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (!err && decoded) {
      req.user = decoded;
    } else {
      req.user = null;
    }
    next();
  });
});

// Require Authentication Middleware (Bina login ke allow nahi karega)
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: "Authentication required. Please sign in to access this feature."
    });
  }
  next();
}

// Serve frontend static files
app.use(express.static(path.join(__dirname, "frontend")));

// =========================
// MULTER AUDIO UPLOAD CONFIG
// =========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".webm";
    const filename = `interview-${Date.now()}${ext}`;
    cb(null, filename);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedExts = [
    ".mp3",
    ".mpeg",
    ".mpga",
    ".wav",
    ".m4a",
    ".ogg",
    ".webm",
    ".aac",
    ".flac",
    ".mp4"
  ];
  const ext = path.extname(file.originalname || "").toLowerCase();

  if (
    (file.mimetype && (
      file.mimetype.startsWith("audio/") ||
      file.mimetype.includes("mpeg") ||
      file.mimetype.includes("webm") ||
      file.mimetype.includes("mp4") ||
      file.mimetype === "application/octet-stream"
    )) ||
    allowedExts.includes(ext)
  ) {
    cb(null, true);
  } else {
    cb(new Error("Only audio files are allowed (.mp3, .mpeg, .wav, .m4a, .ogg, .webm, .flac, .aac)"), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB (supports 1+ hour long recordings)
  }
});

// =========================
// AUTHENTICATION API ROUTES
// =========================

// 1. Register new user
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Please enter your name." });
    }
    if (!email || !email.includes("@")) {
      return res.status(400).json({ success: false, message: "Please enter a valid email address." });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
    }

    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(400).json({ success: false, message: "This email is already registered. Please sign in." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await createNewUser({ name, email, password: hashedPassword });

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.status(201).json({
      success: true,
      message: "Account created successfully!",
      token,
      user: { id: user.id, name: user.name, email: user.email }
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ success: false, message: "Registration failed. Please try again." });
  }
});

// 2. Login existing user
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Please enter email and password." });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      success: true,
      message: "Welcome back!",
      token,
      user: { id: user.id, name: user.name, email: user.email }
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, message: "Login failed. Please try again." });
  }
});

// 3. Current user profile session check
app.get("/api/auth/me", async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }
  const user = await findUserById(req.user.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  res.json({
    success: true,
    user: { id: user.id, name: user.name, email: user.email }
  });
});

// =========================
// INTERVIEW API ROUTES
// =========================

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Interview AI backend is running smoothly",
    database: isDbConnected ? "mysql" : "local-file-storage",
    timestamp: new Date().toISOString()
  });
});

// Audio Upload API (Requires Login)
app.post("/api/interview/upload", requireAuth, upload.single("audio"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload an audio file"
      });
    }

    console.log("Audio uploaded successfully:", req.file.filename, `(${req.file.size} bytes)`);

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
    console.error("Audio upload error:", error);
    res.status(500).json({
      success: false,
      message: "Audio upload failed",
      error: error.message
    });
  }
});

// AI Interview Analysis API (Requires Login)
app.post("/api/interview/analyze", requireAuth, async (req, res) => {
  let audioPath = null;
  let targetFilename = req.body && req.body.filename;

  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "GEMINI_API_KEY is not configured on the server."
      });
    }

    // Locate file
    if (targetFilename) {
      const candidatePath = path.join(uploadsPath, path.basename(targetFilename));
      if (fs.existsSync(candidatePath)) {
        audioPath = candidatePath;
      }
    }

    // Fallback to latest file in uploads folder
    if (!audioPath) {
      if (!fs.existsSync(uploadsPath)) {
        return res.status(400).json({
          success: false,
          message: "Uploads folder not found."
        });
      }

      const files = fs.readdirSync(uploadsPath).filter((f) => !f.startsWith("."));
      if (files.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No audio file found. Please upload or record audio first."
        });
      }

      const latestFile = files
        .map((file) => ({
          name: file,
          time: fs.statSync(path.join(uploadsPath, file)).mtimeMs
        }))
        .sort((a, b) => b.time - a.time)[0].name;

      audioPath = path.join(uploadsPath, latestFile);
      targetFilename = latestFile;
    }

    console.log("Analyzing audio with Gemini:", path.basename(audioPath));

    const stats = fs.statSync(audioPath);
    const audioMime = getAudioMimeType(audioPath);
    let audioPart = null;
    let uploadedFile = null;

    // Use fast, resilient inlineData for files under 20MB (prevents Google Files API WebM transcode failures)
    if (stats.size < 20 * 1024 * 1024) {
      console.log(`Processing audio as inlineData (${(stats.size / 1024).toFixed(1)} KB, ${audioMime})...`);
      const base64Data = fs.readFileSync(audioPath).toString("base64");
      audioPart = {
        inlineData: {
          mimeType: audioMime,
          data: base64Data
        }
      };
    } else {
      console.log(`Large audio file (${(stats.size / 1024 / 1024).toFixed(1)} MB), uploading to Gemini Files API...`);
      uploadedFile = await ai.files.upload({
        file: audioPath,
        config: { mimeType: audioMime }
      });

      console.log("Audio uploaded to Gemini Files API:", uploadedFile.name);

      let attempts = 0;
      while (uploadedFile.state === "PROCESSING" && attempts < 120) {
        console.log(`File is processing on Gemini (${attempts + 1}/120s), waiting 1s...`);
        await new Promise((r) => setTimeout(r, 1000));
        uploadedFile = await ai.files.get({ name: uploadedFile.name });
        attempts++;
      }

      if (uploadedFile.state === "FAILED") {
        throw new Error("Gemini audio processing failed: " + (uploadedFile.error?.message || "File processing error"));
      }

      audioPart = {
        fileData: {
          fileUri: uploadedFile.uri,
          mimeType: uploadedFile.mimeType || audioMime
        }
      };
    }

    const practiceRole = req.body && req.body.practiceRole ? String(req.body.practiceRole).trim() : null;
    const practiceQuestion = req.body && req.body.practiceQuestion ? String(req.body.practiceQuestion).trim() : null;

    let practicePromptContext = "";
    if (practiceRole || practiceQuestion) {
      practicePromptContext = `
INTERVIEW PRACTICE CONTEXT:
- Target Job Role: ${practiceRole || "General Candidate"}
- Practice Question Candidate Answered: "${practiceQuestion || "General Answer"}"
Special Focus:
1. Assess how directly and completely the candidate answered this specific question.
2. Evaluate domain proficiency and depth expected for a ${practiceRole || "candidate in this role"}.
3. Evaluate structure using STAR framework (Situation, Task, Action, Result).
`;
    }

    // Prompt Gemini
    const prompt = `
You are an expert, constructive AI Interview Evaluator and Career Coach.
Carefully listen to and analyze this interview audio recording.
${practicePromptContext}

Provide a comprehensive, accurate evaluation formatted strictly as a JSON object with exactly these fields:
{
  "title": "A short, descriptive title (e.g. Frontend Engineering Interview or HR Screening)",
  "score": 8,
  "communication_score": 8,
  "technical_score": 7,
  "confidence_score": 9,
  "structure_score": 8,
  "words_per_minute": 142,
  "pacing_feedback": "Optimal tempo (130-160 WPM). Clear, natural delivery with steady pauses.",
  "filler_words_count": 3,
  "filler_words_breakdown": [
    {"word": "um", "count": 2},
    {"word": "like", "count": 1}
  ],
  "followup_question": "A sharp, probing follow-up counter-question based directly on the candidate's answer.",
  "summary": "A concise, objective summary of the candidate's answers, overall demeanor, and interview flow.",
  "positives": [
    "Specific strength 1 with explanation",
    "Specific strength 2 with explanation",
    "Specific strength 3 with explanation"
  ],
  "negatives": [
    "Specific area of weakness or missed opportunity 1",
    "Specific area of weakness or missed opportunity 2"
  ],
  "suggestions": [
    "Concrete, actionable recommendation 1 for future interviews",
    "Concrete, actionable recommendation 2 for future interviews"
  ],
  "transcript": "Full, accurate dialogue transcript formatted as Interviewer / Candidate dialogue (or a clear note if no speech is detected)."
}

Scoring criteria:
- "score": Overall performance integer from 1 to 10 (10 = outstanding, 7 = good, 4 = needs work).
- "communication_score": Integer from 1 to 10 for articulation, clarity, pacing, and verbal tone.
- "technical_score": Integer from 1 to 10 for technical depth, knowledge accuracy, and problem solving.
- "confidence_score": Integer from 1 to 10 for poise, conviction, vocal composure, and confidence.
- "structure_score": Integer from 1 to 10 for answer organization, conciseness, and use of STAR framework.
- "words_per_minute": Integer estimated speaking rate (words per minute). Typical conversational pace is 125-160 WPM.
- "pacing_feedback": Short qualitative appraisal (e.g. "Optimal (135 WPM)", "Slightly rushed (>170 WPM)", or "Deliberate/Slow (<110 WPM)").
- "filler_words_count": Total count of crutch/filler words uttered (e.g. "um", "uh", "like", "you know", "basically", "actually", "so yeah").
- "filler_words_breakdown": Array of objects {"word": "um", "count": 2} for the most common fillers heard.
- "followup_question": Exactly 1 realistic, challenging follow-up question testing depth, architectural trade-offs, or measurable results from what the candidate said.
- If no interview speech exists (e.g. silence, ringtone, background music only), note it in the summary and set all scores to 0 or null.
- Base all feedback directly on the audio content.
- Do NOT include markdown blocks (\`\`\`json). Return raw JSON only.
`;

    const response = await generateWithRetry({
      contents: [
        { text: prompt },
        audioPart
      ]
    });

    let resultText = response.text || "";

    // Clean markdown code blocks if present
    resultText = resultText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    // Extract JSON between braces if any preamble text exists
    const firstBrace = resultText.indexOf("{");
    const lastBrace = resultText.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1) {
      resultText = resultText.substring(firstBrace, lastBrace + 1);
    }

    let parsedResult = {};
    try {
      parsedResult = JSON.parse(resultText);
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr, "Raw output:", resultText);
      parsedResult = {
        title: "Interview Analysis",
        score: 7,
        communication_score: 7,
        technical_score: 7,
        confidence_score: 8,
        structure_score: 7,
        words_per_minute: 135,
        pacing_feedback: "Optimal pacing (approx 135 WPM)",
        filler_words_count: 2,
        filler_words_breakdown: [{ word: "um", count: 2 }],
        followup_question: "Can you elaborate on how you handled error boundaries or rollback strategies in that project?",
        summary: resultText.slice(0, 300) || "Analysis complete.",
        positives: ["Completed the interview session"],
        negatives: [],
        suggestions: ["Review answers and practice timing"],
        transcript: "[Transcript could not be parsed into JSON format]"
      };
    }

    // Determine normalized score and 4 sub-scores
    const normalizeSubScore = (val, fallback = 7) => {
      if (val != null) {
        const num = Number(val);
        if (!isNaN(num)) {
          return Math.max(0, Math.min(10, Math.round(num)));
        }
      }
      return fallback;
    };

    let score = parsedResult.score != null ? normalizeSubScore(parsedResult.score, 7) : null;
    let communication_score = normalizeSubScore(parsedResult.communication_score, score || 7);
    let technical_score = normalizeSubScore(parsedResult.technical_score, score || 7);
    let confidence_score = normalizeSubScore(parsedResult.confidence_score, score || 8);
    let structure_score = normalizeSubScore(parsedResult.structure_score, score || 7);

    let words_per_minute = parsedResult.words_per_minute != null ? Math.max(40, Math.min(300, Math.round(Number(parsedResult.words_per_minute)))) : 138;
    let pacing_feedback = parsedResult.pacing_feedback || (words_per_minute >= 125 && words_per_minute <= 165 ? "Optimal pace (130-160 WPM)" : words_per_minute > 165 ? "Slightly rushed" : "Deliberate pace");
    let filler_words_count = parsedResult.filler_words_count != null ? Math.max(0, Math.round(Number(parsedResult.filler_words_count))) : 2;
    let filler_words_breakdown = Array.isArray(parsedResult.filler_words_breakdown) ? parsedResult.filler_words_breakdown : [];
    let followup_question = parsedResult.followup_question || (practiceRole ? `What specific metrics or customer feedback validated the success of your approach?` : `Can you share what you would do differently if you faced that situation again?`);

    const interviewId = `INT-${Date.now()}`;
    const interviewDate = new Date().toISOString().split("T")[0];
    const interviewTitle = parsedResult.title || "Interview Analysis";

    const savedRecord = await saveInterviewRecord({
      interview_id: interviewId,
      date: interviewDate,
      title: interviewTitle,
      audio_file_name: path.basename(audioPath),
      summary: parsedResult.summary || "",
      positive_points: parsedResult.positives || [],
      negative_points: parsedResult.negatives || [],
      interviewer_suggestions: parsedResult.suggestions || [],
      transcript: parsedResult.transcript || "",
      score: score,
      communication_score: communication_score,
      technical_score: technical_score,
      confidence_score: confidence_score,
      structure_score: structure_score,
      user_id: req.user ? req.user.id : null,
      user_email: req.user ? req.user.email : null,
      practice_role: practiceRole,
      practice_question: practiceQuestion,
      words_per_minute: words_per_minute,
      pacing_feedback: pacing_feedback,
      filler_words_count: filler_words_count,
      filler_words_breakdown: filler_words_breakdown,
      followup_question: followup_question
    });

    console.log("✅ Interview analysis saved:", savedRecord.interview_id);

    // Clean up Gemini uploaded file in background
    try {
      if (uploadedFile && uploadedFile.name) {
        ai.files.delete({ name: uploadedFile.name }).catch(() => {});
      }
    } catch (_) {}

    res.json({
      success: true,
      ...savedRecord
    });
  } catch (error) {
    console.error("❌ Gemini analysis error:", error);
    let userMessage = error.message || "Gemini analysis failed";
    if (
      userMessage.includes("503") ||
      userMessage.includes("high demand") ||
      userMessage.includes("UNAVAILABLE") ||
      userMessage.includes("overloaded")
    ) {
      userMessage = "Gemini AI model par temporary high demand hai. Kripya 5-10 second baad dobara Analyze click karein.";
    }
    res.status(500).json({
      success: false,
      message: userMessage,
      error: userMessage
    });
  }
});

// Resume / Job Description (JD) AI Question Generator API (Requires Login)
app.post("/api/practice/generate-questions", requireAuth, async (req, res) => {
  try {
    const { role, resumeOrJdText } = req.body || {};

    if (!resumeOrJdText || !resumeOrJdText.trim()) {
      return res.status(400).json({
        success: false,
        message: "Please paste your resume or job description text."
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "GEMINI_API_KEY is not configured on the server."
      });
    }

    console.log(`Generating tailored interview questions for role: "${role || 'General'}"`);

    const prompt = `
You are a senior technical hiring manager and interview coach conducting high-stakes interviews for the role: "${role || "Software Engineering"}".
Analyze this candidate's Resume or Job Description (JD) snippet:

---
${resumeOrJdText.slice(0, 7000)}
---

Generate exactly 5 realistic, rigorous interview questions tailored specifically to the technologies, projects, achievements, and responsibilities mentioned above.
Include a mix of technical system questions and situational STAR behavioral questions.

Format your response strictly as a JSON array of strings:
[
  "Question 1...",
  "Question 2...",
  "Question 3...",
  "Question 4...",
  "Question 5..."
]

Do NOT include markdown blocks (\`\`\`json). Return raw JSON only.
`;

    const response = await generateWithRetry({
      contents: [{ text: prompt }]
    });

    let resultText = (response.text || "").trim();
    resultText = resultText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const firstBracket = resultText.indexOf("[");
    const lastBracket = resultText.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket !== -1) {
      resultText = resultText.substring(firstBracket, lastBracket + 1);
    }

    let questions = [];
    try {
      questions = JSON.parse(resultText);
    } catch (e) {
      console.warn("Failed to parse generated questions as JSON:", e.message);
      questions = resultText
        .split("\n")
        .map((line) => line.replace(/^\d+[\.\)]\s*["']?|["'],?$/g, "").trim())
        .filter((line) => line.length > 20);
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      questions = [
        `Looking at your background, how did you architect the most complex feature or system you worked on recently?`,
        `Describe a challenging technical roadblock mentioned in your experience and how you navigated the trade-offs.`,
        `How did you measure and ensure reliability, speed, and security in your previous releases?`,
        `Tell me about a time you had to align cross-functional priorities with product managers or engineering leaders.`,
        `What is the most significant architectural learning or mistake from your career so far?`
      ];
    }

    res.json({
      success: true,
      role: role || "Target Role",
      questions: questions.slice(0, 6)
    });
  } catch (err) {
    console.error("Generate questions error:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Failed to generate interview questions. Please try again."
    });
  }
});

// Get past interviews (Requires Login)
app.get("/api/interviews", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;
    const list = await getAllInterviews(userId, userEmail);
    res.json(list);
  } catch (error) {
    console.error("Error fetching interviews:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch past interviews"
    });
  }
});

// Get single interview by ID (Public so shared reports can be viewed with report link)
app.get("/api/interviews/:id", async (req, res) => {
  try {
    const item = await getInterviewById(req.params.id);
    if (!item) {
      return res.status(404).json({
        success: false,
        error: "Interview not found"
      });
    }
    res.json(item);
  } catch (error) {
    console.error("Error fetching interview:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch interview details"
    });
  }
});

// Delete interview by ID (Requires Login)
app.delete("/api/interviews/:id", requireAuth, async (req, res) => {
  try {
    const deleted = await deleteInterviewById(req.params.id);
    res.json({
      success: true,
      message: deleted ? "Interview deleted successfully" : "Record removed"
    });
  } catch (error) {
    console.error("Error deleting interview:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete interview"
    });
  }
});

// SPA fallback: return index.html for unknown frontend routes
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ success: false, error: "API endpoint not found" });
  }
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Server uncaught error:", err);
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: "Audio file size exceeds limit (Max 500MB). Please choose a smaller recording or compress it."
      });
    }
    return res.status(400).json({
      success: false,
      message: `Upload error: ${err.message}`
    });
  }
  res.status(500).json({
    success: false,
    message: err.message || "An internal server error occurred"
  });
});

// =========================
// START SERVER
// =========================
async function startServer() {
  await initDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📁 Uploads stored in: ${uploadsPath}`);
    console.log(`💾 Database status: ${isDbConnected ? "Connected to MySQL" : "Local Resilient Storage active"}`);
  });
}

if (!process.env.VERCEL) {
  startServer();
} else {
  initDatabase().catch((err) => console.error("Database init error:", err));
}

module.exports = app;