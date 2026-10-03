# IntervAI - AI Interview Evaluation & Coach

IntervAI is a full-stack AI interview recording, evaluation, and feedback platform powered by Google Gemini AI.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hoshil05-codes/INTERVIEW-AI)
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/new?template=https://github.com/hoshil05-codes/INTERVIEW-AI)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/hoshil05-codes/INTERVIEW-AI)

---

## 🚀 Features

- 🎙️ **Live Audio Recording:** Record in-browser with real-time sound visualizer, timer, pause/resume, and system call audio capture.
- 📁 **File Upload:** Upload existing audio recordings (.mp3, .wav, .m4a, .ogg, .webm).
- 🧠 **Gemini AI Analysis:** In-depth evaluation with structured feedback:
  - Overall performance score (1-10) with animated scorecard
  - Key positive strengths
  - Constructive areas for improvement
  - Actionable coaching tips for future interviews
  - Full verbatim transcript
- 📜 **Past Interviews History:** Browse, inspect, or delete previous interview records.
- 💾 **Resilient Storage:** Seamlessly connects to Cloud MySQL (TiDB, Aiven, Railway) with an automatic zero-crash local storage fallback.

---

## ⚡ 1-Click Online Deployment

### Option 1: Render (Recommended - Free Web Service)
1. Click the **[Deploy to Render](https://render.com/deploy?repo=https://github.com/hoshil05-codes/INTERVIEW-AI)** button.
2. Sign in with GitHub.
3. Add your `GEMINI_API_KEY` (get one for free at [Google AI Studio](https://aistudio.google.com/)).
4. Click **Apply** / **Deploy**. Your site will be live on a public `*.onrender.com` URL within minutes!

### Option 2: Railway
1. Click **[Deploy on Railway](https://railway.app/template/new?template=https://github.com/hoshil05-codes/INTERVIEW-AI)**.
2. Add your `GEMINI_API_KEY` variable.
3. Deploy!

---

## 🛠️ Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | **Required** Google Gemini API Key | - |
| `PORT` | Server Port | `5000` |
| `DATABASE_URL` | Optional MySQL connection string | - |
| `DB_HOST` | MySQL host | `localhost` |
| `DB_USER` | MySQL user | `root` |
| `DB_PASSWORD` | MySQL password | - |
| `DB_NAME` | MySQL database name | `intreviewapp` |
| `DB_PORT` | MySQL port | `3306` |
