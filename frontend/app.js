// ============================================================
// INTERVIEW AI - FRONTEND APP.JS
// ============================================================

// STEP 1: SHORTCUTS AND SHARED STORAGE
console.log("APP JS LOADED");
const $ = (id) => {
  const el = document.getElementById(id);

  if (!el) {
    console.error(
      `Missing element with id="${id}" in index.html.`
    );
  }

  return el;
};

const rec = {
  recorder: null,
  stream: null,
  micStream: null,
  displayStream: null,
  mixCtx: null,
  chunks: [],
  blob: null,
  startTime: 0,
  pausedMs: 0,
  pauseStart: 0,
  timerId: null,
  audioCtx: null,
  meterId: null,
  wakeLock: null,
  micLost: false,
};


// ============================================================
// STEP 2: SMALL HELPER FUNCTIONS
// ============================================================

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatClock(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function showError(message) {
  const box = $("error");

  if (!box) return;

  box.textContent = message;
  box.hidden = false;
}

function clearError() {
  const box = $("error");

  if (box) {
    box.hidden = true;
  }
}

function setStatus(text) {
  const status = $("status");

  if (status) {
    status.textContent = text;
  }
}

function pickMimeType() {
  const options = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus"
  ];

  return (
    options.find(
      (t) =>
        window.MediaRecorder &&
        MediaRecorder.isTypeSupported(t)
    ) || ""
  );
}

function extensionFor(mime) {
  mime = mime || "";

  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";

  return "audio";
}


// ============================================================
// STEP 3: MOVING BETWEEN SCREENS
// ============================================================

const STEPS = [
  "screen-home",
  "screen-mode",
  "screen-record",
  "screen-upload",
  "screen-review",
  "screen-loading"
];

function goStep(id) {
  if (!currentUser && id !== "screen-home") {
    openAuthModal("login");
    return;
  }

  for (const s of STEPS) {
    const element = $(s);

    if (element) {
      element.hidden = s !== id;
    }
  }

  clearError();
}

function showView(name) {
  if (!currentUser) {
    openAuthModal("login");
    return;
  }

  const isNew = name === "new";

  const viewNew = $("view-new");
  const viewPast = $("view-past");
  const tabNew = $("tab-new");
  const tabPast = $("tab-past");
  const results = $("results");

  if (viewNew) viewNew.hidden = !isNew;
  if (viewPast) viewPast.hidden = isNew;

  if (tabNew) {
    tabNew.setAttribute(
      "aria-current",
      isNew ? "page" : "false"
    );
  }

  if (tabPast) {
    tabPast.setAttribute(
      "aria-current",
      isNew ? "false" : "page"
    );
  }

  if (results) {
    results.hidden = true;
  }

  clearError();

  if (isNew) {
    goStep("screen-home");
  } else {
    loadPastList();
  }
}

if ($("tab-new")) {
  $("tab-new").addEventListener("click", () => {
    showView("new");
  });
}

if ($("tab-past")) {
  $("tab-past").addEventListener("click", () => {
    showView("past");
  });
}

if ($("brand-home")) {
  $("brand-home").addEventListener("click", () => {
    showView("new");
  });
}


// ============================================================
// STEP 4: HOME AND MODE BUTTONS
// ============================================================

if ($("btn-goto-mode")) {
  $("btn-goto-mode").addEventListener("click", () => {
    goStep("screen-mode");
  });
}

if ($("btn-hero-past")) {
  $("btn-hero-past").addEventListener("click", () => {
    showView("past");
  });
}

if ($("mode-live")) {
  $("mode-live").addEventListener("click", () => {
    goStep("screen-record");
    loadMics();
  });
}

if ($("mode-upload")) {
  $("mode-upload").addEventListener("click", () => {
    goStep("screen-upload");
  });
}

for (const btn of document.querySelectorAll(".back")) {
  if (btn.dataset.back) {
    btn.addEventListener("click", () => {
      goStep(btn.dataset.back);
    });
  }
}

if ($("btn-results-new")) {
  $("btn-results-new").addEventListener("click", () => {
    showView("new");
  });
}


// ============================================================
// STEP 5: SOUND METER
// ============================================================

const BAR_COUNT = 24;

if ($("meter")) {
  for (let i = 0; i < BAR_COUNT; i++) {
    $("meter").appendChild(
      document.createElement("span")
    );
  }
}

function startMeter(stream) {
  if (!stream) return;

  rec.audioCtx =
    new (window.AudioContext ||
      window.webkitAudioContext)();

  const source =
    rec.audioCtx.createMediaStreamSource(stream);

  const analyser =
    rec.audioCtx.createAnalyser();

  analyser.fftSize = 128;

  source.connect(analyser);

  const data =
    new Uint8Array(analyser.frequencyBinCount);

  const bars = $("meter")
    ? $("meter").children
    : [];

  function draw() {
    analyser.getByteFrequencyData(data);

    for (let i = 0; i < BAR_COUNT; i++) {
      const value = data[i + 2] / 255;

      if (bars[i]) {
        bars[i].style.height =
          `${Math.max(4, value * 56)}px`;
      }
    }

    rec.meterId =
      requestAnimationFrame(draw);
  }

  draw();
}

function stopMeter() {
  if (rec.meterId) {
    cancelAnimationFrame(rec.meterId);
  }

  if (rec.audioCtx) {
    rec.audioCtx.close();
  }

  rec.audioCtx = null;

  if ($("meter")) {
    for (const bar of $("meter").children) {
      bar.style.height = "4px";
    }
  }
}


// ============================================================
// STEP 6: TIMER
// ============================================================

function elapsedSeconds() {
  const now = rec.pauseStart || Date.now();

  return Math.max(
    0,
    Math.floor(
      (
        now -
        rec.startTime -
        rec.pausedMs
      ) / 1000
    )
  );
}

function startTimer() {
  rec.timerId = setInterval(() => {
    if ($("timer")) {
      $("timer").textContent =
        formatClock(elapsedSeconds());
    }
  }, 250);
}

function stopTimer() {
  clearInterval(rec.timerId);
}


// ============================================================
// STEP 7: MICROPHONE LIST
// ============================================================

const BLUETOOTH_PATTERN =
  /bluetooth|hands-?free|airpods|buds|headset/i;

async function loadMics() {
  if (
    !navigator.mediaDevices ||
    !navigator.mediaDevices.enumerateDevices
  ) {
    return;
  }

  const select = $("mic-select");

  if (!select) return;

  const previous = select.value;

  let devices =
    await navigator.mediaDevices.enumerateDevices();

  if (
    devices.some(
      (d) =>
        d.kind === "audioinput" &&
        !d.label
    )
  ) {
    try {
      const probe =
        await navigator.mediaDevices.getUserMedia({
          audio: true
        });

      probe
        .getTracks()
        .forEach((t) => t.stop());

      devices =
        await navigator.mediaDevices.enumerateDevices();
    } catch {
      // Permission blocked.
    }
  }

  const mics = devices.filter(
    (d) =>
      d.kind === "audioinput" &&
      d.deviceId !== "default" &&
      d.deviceId !== "communications"
  );

  const bluetoothMics =
    mics.filter((d) =>
      BLUETOOTH_PATTERN.test(d.label)
    );

  const normalMics =
    mics.filter(
      (d) =>
        !BLUETOOTH_PATTERN.test(d.label)
    );

  select.replaceChildren();

  const normal =
    document.createElement("option");

  normal.value =
    normalMics.length
      ? normalMics[0].deviceId
      : "";

  normal.textContent =
    "Default microphone";

  select.appendChild(normal);

  bluetoothMics.forEach((d, i) => {
    const opt =
      document.createElement("option");

    opt.value = d.deviceId;

    opt.textContent =
      `Microphone ${i + 1} (Bluetooth)`;

    select.appendChild(opt);
  });

  if (
    [...select.options].some(
      (o) => o.value === previous
    )
  ) {
    select.value = previous;
  }
}

function micErrorMessage(
  err,
  hasChosenMic
) {
  switch (err && err.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access was blocked. Allow microphone access and try again.";

    case "NotFoundError":
    case "OverconstrainedError":
      return hasChosenMic
        ? "That microphone is not available. Pick another one."
        : "No microphone was found. Connect a microphone or headset.";

    case "NotReadableError":
    case "AbortError":
      return "The microphone is busy. Close other apps or tabs using it.";

    default:
      return "The microphone could not be started. Check it and try again.";
  }
}

if ($("mic-select")) {
  $("mic-select").addEventListener(
    "change",
    async () => {
      clearError();

      const id =
        $("mic-select").value;

      try {
        const test =
          await navigator.mediaDevices.getUserMedia({
            audio: id
              ? {
                  deviceId: {
                    exact: id
                  }
                }
              : true
          });

        test
          .getTracks()
          .forEach((t) => t.stop());

        setStatus("Ready to record.");
      } catch (err) {
        showError(
          micErrorMessage(
            err,
            Boolean(id)
          )
        );
      }
    }
  );
}

if (
  navigator.mediaDevices &&
  navigator.mediaDevices.addEventListener
) {
  navigator.mediaDevices.addEventListener(
    "devicechange",
    loadMics
  );
}


// ============================================================
// STEP 8: GET AUDIO TO RECORD
// ============================================================

async function getRecordingStream(
  audioOptions
) {
  const micStream =
    await navigator.mediaDevices.getUserMedia({
      audio: audioOptions
    });

  rec.micStream = micStream;

  if (!$("capture-tab").checked) {
    return micStream;
  }

  let displayStream;

  try {
    displayStream =
      await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });
  } catch {
    micStream
      .getTracks()
      .forEach((t) => t.stop());

    throw new Error("TAB_AUDIO_DENIED");
  }

  if (
    displayStream.getAudioTracks().length === 0
  ) {
    displayStream
      .getTracks()
      .forEach((t) => t.stop());

    micStream
      .getTracks()
      .forEach((t) => t.stop());

    throw new Error("TAB_AUDIO_MISSING");
  }

  rec.displayStream = displayStream;

  const ctx =
    new (window.AudioContext ||
      window.webkitAudioContext)();

  const dest =
    ctx.createMediaStreamDestination();

  ctx
    .createMediaStreamSource(micStream)
    .connect(dest);

  ctx
    .createMediaStreamSource(
      new MediaStream(
        displayStream.getAudioTracks()
      )
    )
    .connect(dest);

  rec.mixCtx = ctx;

  displayStream
    .getAudioTracks()[0]
    .addEventListener("ended", () => {
      if (
        rec.recorder &&
        rec.recorder.state !== "inactive"
      ) {
        setStatus(
          "Call audio sharing stopped. Only microphone is being recorded now."
        );
      }
    });

  return dest.stream;
}

function releaseStreams() {
  for (
    const s of [
      rec.stream,
      rec.micStream,
      rec.displayStream
    ]
  ) {
    if (s) {
      s.getTracks().forEach((t) => t.stop());
    }
  }

  if (rec.mixCtx) {
    rec.mixCtx.close();
  }

  rec.stream = null;
  rec.micStream = null;
  rec.displayStream = null;
  rec.mixCtx = null;
}


// ============================================================
// STEP 9: START RECORDING
// ============================================================

async function startRecording() {
  clearError();

  if (
    !navigator.mediaDevices ||
    !window.MediaRecorder
  ) {
    showError(
      "This browser cannot record audio. Use Chrome, Edge or Firefox, or upload a file instead."
    );

    return;
  }

  const audioOptions = {
    echoCancellation: true,
    noiseSuppression: true
  };

  const micId =
    $("mic-select")
      ? $("mic-select").value
      : "";

  if (micId) {
    audioOptions.deviceId = {
      exact: micId
    };
  }

  try {
    rec.stream =
      await getRecordingStream(
        audioOptions
      );
  } catch (err) {
    if (
      err.message ===
      "TAB_AUDIO_DENIED"
    ) {
      showError(
        "Call audio was not shared. Try again and share the call tab audio."
      );

      return;
    }

    if (
      err.message ===
      "TAB_AUDIO_MISSING"
    ) {
      showError(
        "No audio came with the shared screen. Choose a Chrome tab and share tab audio."
      );

      return;
    }

    showError(
      micErrorMessage(
        err,
        Boolean(micId)
      )
    );

    if (
      err.name === "NotFoundError" ||
      err.name === "OverconstrainedError"
    ) {
      loadMics();
    }

    return;
  }

  loadMics();

  rec.micLost = false;

  const audioTracks =
    (rec.micStream || rec.stream)
      .getAudioTracks();

  if (audioTracks.length) {
    audioTracks[0].addEventListener(
      "ended",
      () => {
        if (
          rec.recorder &&
          rec.recorder.state !== "inactive"
        ) {
          rec.micLost = true;
          stopRecording();
        }
      }
    );
  }

  const mimeType =
    pickMimeType();

  rec.chunks = [];

  rec.recorder =
    new MediaRecorder(
      rec.stream,
      mimeType
        ? {
            mimeType,
            audioBitsPerSecond: 32000
          }
        : {}
    );

  rec.recorder.ondataavailable =
    (e) => {
      if (e.data.size > 0) {
        rec.chunks.push(e.data);
      }
    };

  rec.recorder.onstop =
    onRecordingStopped;

  rec.recorder.start(10000);

  rec.startTime = Date.now();
  rec.pausedMs = 0;
  rec.pauseStart = 0;

  startTimer();
  startMeter(rec.stream);
  keepScreenAwake();

  const recorderElement =
    document.querySelector(".recorder");

  if (recorderElement) {
    recorderElement.classList.add(
      "is-recording"
    );
  }

  if ($("btn-start"))
    $("btn-start").hidden = true;

  if ($("btn-pause"))
    $("btn-pause").hidden = false;

  if ($("btn-stop"))
    $("btn-stop").hidden = false;

  if ($("mic-select"))
    $("mic-select").disabled = true;

  setStatus(
    "Recording. Keep this tab open."
  );
}


// ============================================================
// STEP 10: PAUSE / RESUME
// ============================================================

function togglePause() {
  if (!rec.recorder) return;

  if (
    rec.recorder.state ===
    "recording"
  ) {
    rec.recorder.pause();

    rec.pauseStart =
      Date.now();

    $("btn-pause").textContent =
      "Resume";

    setStatus("Paused.");

  } else if (
    rec.recorder.state ===
    "paused"
  ) {
    rec.recorder.resume();

    rec.pausedMs +=
      Date.now() -
      rec.pauseStart;

    rec.pauseStart = 0;

    $("btn-pause").textContent =
      "Pause";

    setStatus(
      "Recording. Keep this tab open."
    );
  }
}


// ============================================================
// STEP 11: STOP RECORDING
// ============================================================

function stopRecording() {
  if (
    rec.recorder &&
    rec.recorder.state !== "inactive"
  ) {
    rec.recorder.stop();
  }
}

function onRecordingStopped() {
  stopTimer();
  stopMeter();
  releaseScreenAwake();
  releaseStreams();

  const type =
    rec.recorder.mimeType ||
    "audio/webm";

  rec.blob =
    new Blob(
      rec.chunks,
      { type }
    );

  if (rec.blob.size === 0) {
    rec.blob = null;

    if ($("timer")) {
      $("timer").textContent =
        "00:00:00";
    }

    showError(
      rec.micLost
        ? "The microphone was disconnected before anything was captured."
        : "Nothing was recorded. Check your microphone and try again."
    );

  } else {

    if ($("btn-download")) {
      $("btn-download").hidden = false;
    }

    showReview(rec.blob);

    if (rec.micLost) {
      showError(
        "The microphone was disconnected. Your recording up to that point has been kept."
      );
    }
  }

  rec.micLost = false;

  const recorderElement =
    document.querySelector(".recorder");

  if (recorderElement) {
    recorderElement.classList.remove(
      "is-recording"
    );
  }

  if ($("btn-start"))
    $("btn-start").hidden = false;

  if ($("btn-pause")) {
    $("btn-pause").hidden = true;
    $("btn-pause").textContent =
      "Pause";
  }

  if ($("btn-stop"))
    $("btn-stop").hidden = true;

  if ($("mic-select"))
    $("mic-select").disabled = false;
}


// ============================================================
// STEP 12: RECORD BUTTONS
// ============================================================

if ($("btn-start")) {
  $("btn-start").addEventListener(
    "click",
    startRecording
  );
}

if ($("btn-pause")) {
  $("btn-pause").addEventListener(
    "click",
    togglePause
  );
}

if ($("btn-stop")) {
  $("btn-stop").addEventListener(
    "click",
    stopRecording
  );
}


// ============================================================
// STEP 13: KEEP SCREEN AWAKE
// ============================================================

async function keepScreenAwake() {
  try {
    rec.wakeLock =
      await navigator.wakeLock.request(
        "screen"
      );
  } catch {
    // Not supported.
  }
}

function releaseScreenAwake() {
  if (rec.wakeLock) {
    rec.wakeLock
      .release()
      .catch(() => {});
  }

  rec.wakeLock = null;
}

window.addEventListener(
  "beforeunload",
  (e) => {
    if (
      rec.recorder &&
      rec.recorder.state !==
        "inactive"
    ) {
      e.preventDefault();
      e.returnValue = "";
    }
  }
);


// ============================================================
// STEP 14: REVIEW
// ============================================================

function showReview(blob) {
  const player = $("player");

  if (!player) return;

  player.src =
    URL.createObjectURL(blob);

  player.addEventListener(
    "loadedmetadata",
    function fixDuration() {

      if (
        player.duration !== Infinity &&
        !Number.isNaN(
          player.duration
        )
      ) {
        return;
      }

      player.removeEventListener(
        "loadedmetadata",
        fixDuration
      );

      player.currentTime =
        1e101;

      player.addEventListener(
        "timeupdate",
        function reset() {

          player.removeEventListener(
            "timeupdate",
            reset
          );

          player.currentTime = 0;
        }
      );
    }
  );

  goStep("screen-review");

  if ($("results")) {
    $("results").hidden = true;
  }
}


// ============================================================
// STEP 15: AUDIO FILE CHECK
// ============================================================

const MAX_UPLOAD_MB = 500;

const ALLOWED_EXTENSIONS = [
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "webm"
];

function checkAudio(blob) {
  if (!blob || blob.size === 0) {
    return "This audio is empty. Record again or choose another file.";
  }

  if (
    blob.size >
    MAX_UPLOAD_MB * 1024 * 1024
  ) {
    return `This file is too large. The limit is ${MAX_UPLOAD_MB} MB.`;
  }

  if (blob.name) {
    const ext =
      blob.name
        .split(".")
        .pop()
        .toLowerCase();

    const isAudio =
      (blob.type || "").startsWith(
        "audio/"
      ) ||
      ALLOWED_EXTENSIONS.includes(
        ext
      );

    if (!isAudio) {
      return "This file is not a supported audio file. Use mp3, wav, m4a, ogg or webm.";
    }
  }

  return "";
}


// ============================================================
// STEP 16: FILE UPLOAD FROM DEVICE
// ============================================================

if ($("file")) {
  $("file").addEventListener(
    "change",
    (e) => {

      const file =
        e.target.files[0];

      if (!file) return;

      clearError();

      const problem =
        checkAudio(file);

      if (problem) {
        showError(problem);
        e.target.value = "";
        return;
      }

      rec.blob = file;

      if ($("btn-download")) {
        $("btn-download").hidden =
          true;
      }

      showReview(file);

      e.target.value = "";
    }
  );
}


// ============================================================
// STEP 17: DOWNLOAD RECORDING
// ============================================================

if ($("btn-download")) {
  $("btn-download").addEventListener(
    "click",
    () => {

      if (!rec.blob) return;

      const ext =
        extensionFor(
          rec.blob.type ||
          rec.blob.name ||
          ""
        );

      const stamp =
        new Date()
          .toISOString()
          .slice(0, 16)
          .replace(/[:T]/g, "-");

      const link =
        document.createElement("a");

      link.href =
        URL.createObjectURL(
          rec.blob
        );

      link.download =
        `interview-${stamp}.${ext}`;

      link.click();

      setTimeout(() => {
        URL.revokeObjectURL(
          link.href
        );
      }, 1000);
    }
  );
}


// ============================================================
// STEP 18: DISCARD
// ============================================================

if ($("btn-discard")) {
  $("btn-discard").addEventListener(
    "click",
    () => {

      rec.blob = null;

      if ($("player")) {
        $("player").removeAttribute(
          "src"
        );
      }

      if ($("timer")) {
        $("timer").textContent =
          "00:00:00";
      }

      goStep("screen-home");
    }
  );
}


// ============================================================
// STEP 19: UPLOAD + AI ANALYSIS
// ============================================================

let elapsedId = null;

async function analyze() {

  if (!rec.blob) {
    showError(
      "Please record or select an audio file first."
    );
    return;
  }

  clearError();

  const problem =
    checkAudio(rec.blob);

  if (problem) {
    showError(problem);
    return;
  }

  if ($("results")) {
    $("results").hidden = true;
  }

  // ----------------------------------------------------------
  // CREATE FORM DATA
  // ----------------------------------------------------------

  const form = new FormData();

  form.append(
    "audio",
    rec.blob,
    `interview.${extensionFor(
      rec.blob.type ||
      rec.blob.name ||
      ""
    )}`
  );

  if ($("transcript-opt")) {
    form.append(
      "includeTranscript",
      $("transcript-opt").checked
    );
  }

  goStep("screen-loading");

  const began =
    Date.now();

  elapsedId =
    setInterval(() => {

      const s =
        Math.floor(
          (Date.now() - began) /
            1000
        );

      if ($("elapsed")) {
        $("elapsed").textContent =
          `${Math.floor(s / 60)}:${pad(
            s % 60
          )}`;
      }

    }, 500);


  try {

    // ========================================================
    // STEP A: UPLOAD AUDIO TO BACKEND
    // ========================================================

    console.log(
      "Uploading audio to backend..."
    );

    const uploadRes =
      await fetch(
        "/api/interview/upload",
        {
          method: "POST",
          headers: getAuthHeaders(),
          body: form
        }
      );

    const uploadData =
      await uploadRes
        .json()
        .catch(() => ({}));

    if (!uploadRes.ok) {
      throw new Error(
        uploadData.error ||
        uploadData.message ||
        "Audio upload failed."
      );
    }

    console.log(
      "Audio upload successful:",
      uploadData
    );


    // ========================================================
    // STEP B: START GEMINI ANALYSIS
    // ========================================================

    console.log(
      "Starting AI analysis..."
    );

    const analyzeRes =
      await fetch(
        "/api/interview/analyze",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
            ...getAuthHeaders()
          },

          body: JSON.stringify({
            filename:
              uploadData.file
                ? uploadData.file.filename
                : null
          })
        }
      );

    const analyzeData =
      await analyzeRes
        .json()
        .catch(() => ({}));

    if (!analyzeRes.ok) {
      throw new Error(
        analyzeData.error ||
        analyzeData.message ||
        "Interview analysis failed."
      );
    }


    // ========================================================
    // STEP C: ANALYSIS SUCCESS
    // ========================================================

    console.log(
      "AI analysis successful:",
      analyzeData
    );


    // ========================================================
    // STEP D: DISPLAY RESULT
    // ========================================================

    renderResult({
      ...analyzeData,

      title:
        analyzeData.title ||
        "Interview",

      createdAt:
        analyzeData.createdAt ||
        new Date().toISOString()
    });


  } catch (err) {

    console.error(
      "Analysis error:",
      err
    );

    goStep(
      "screen-review"
    );

    showError(
      err instanceof TypeError
        ? "Could not reach the server. Check that it is running."
        : err.message
    );

  } finally {

    clearInterval(
      elapsedId
    );
  }
}

if ($("btn-analyze")) {
  $("btn-analyze").addEventListener(
    "click",
    analyze
  );
}


// ============================================================
// STEP 20: SHOW RESULTS
// ============================================================

function fillList(id, items) {

  const ul = $(id);

  if (!ul) return;

  ul.replaceChildren();

  if (typeof items === "string") {
    try {
      const parsed = JSON.parse(items);
      if (Array.isArray(parsed)) items = parsed;
      else items = [items];
    } catch {
      items = items ? [items] : [];
    }
  }

  if (
    !items ||
    !Array.isArray(items) ||
    items.length === 0
  ) {

    const li =
      document.createElement(
        "li"
      );

    li.textContent =
      "Nothing to report.";

    li.className =
      "muted";

    ul.appendChild(li);

    return;
  }

  for (const text of items) {

    const li =
      document.createElement(
        "li"
      );

    li.textContent =
      text;

    ul.appendChild(li);
  }
}


const SCORE_RING_LENGTH =
  213.6;


function renderScoreCard(score) {

  const card =
    $("score-card");

  if (!card) return;

  if (score == null) {
    card.hidden = true;
    return;
  }

  card.hidden = false;

  const clamped =
    Math.max(
      0,
      Math.min(
        10,
        Number(score)
      )
    );

  const offset =
    SCORE_RING_LENGTH *
    (1 - clamped / 10);

  if ($("score-fill")) {
    $("score-fill")
      .style
      .strokeDashoffset =
      String(offset);

    $("score-fill")
      .style
      .stroke =
      clamped >= 7
        ? "var(--sage)"
        : clamped >= 4
        ? "var(--gold)"
        : "var(--rust)";
  }

  if ($("score-value")) {
    $("score-value").textContent =
      Math.round(clamped);
  }
}


let activeResultData = null;

function renderResult(data) {
  activeResultData = data;

  // Hide all screens
  for (const s of STEPS) {
    const element = $(s);
    if (element) {
      element.hidden = true;
    }
  }

  if ($("r-title")) {
    $("r-title").textContent =
      data.title ||
      "Interview";
  }

  if ($("r-meta")) {
    const date =
      data.createdAt
        ? new Date(
            data.createdAt
          )
        : new Date();

    $("r-meta").textContent =
      date.toLocaleString();
  }

  renderScoreCard(
    data.score
  );

  // Render 4-Metric Performance Breakdown
  const baseScore = data.score != null ? Number(data.score) : 7;
  const comm = data.communication_score != null ? Number(data.communication_score) : baseScore;
  const tech = data.technical_score != null ? Number(data.technical_score) : baseScore;
  const conf = data.confidence_score != null ? Number(data.confidence_score) : Math.min(10, baseScore + 1);
  const struct = data.structure_score != null ? Number(data.structure_score) : baseScore;

  if ($("score-comm")) $("score-comm").textContent = `${comm}/10`;
  if ($("bar-comm")) $("bar-comm").style.width = `${Math.min(100, Math.max(5, comm * 10))}%`;

  if ($("score-tech")) $("score-tech").textContent = `${tech}/10`;
  if ($("bar-tech")) $("bar-tech").style.width = `${Math.min(100, Math.max(5, tech * 10))}%`;

  if ($("score-conf")) $("score-conf").textContent = `${conf}/10`;
  if ($("bar-conf")) $("bar-conf").style.width = `${Math.min(100, Math.max(5, conf * 10))}%`;

  if ($("score-struct")) $("score-struct").textContent = `${struct}/10`;
  if ($("bar-struct")) $("bar-struct").style.width = `${Math.min(100, Math.max(5, struct * 10))}%`;

  if ($("r-summary")) {
    $("r-summary").textContent =
      data.summary || "";
  }

  fillList(
    "r-pos",
    data.positive_points ||
    data.positives
  );

  fillList(
    "r-neg",
    data.negative_points ||
    data.negatives
  );

  fillList(
    "r-sug",
    data.interviewer_suggestions ||
    data.suggestions
  );

  const hasTranscript =
    Boolean(data.transcript);

  if ($("r-transcript-box")) {
    $("r-transcript-box").hidden =
      !hasTranscript;
  }

  if ($("r-transcript")) {
    $("r-transcript").textContent =
      hasTranscript
        ? data.transcript
        : "";
  }

  if ($("results")) {
    $("results").hidden =
      false;

    $("results").scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }
}

// ============================================================
// STEP 20B: ACTION BAR (PDF DOWNLOAD, COPY SUMMARY & SHARE)
// ============================================================

let toastTimeout = null;
function showToast(msg) {
  const t = $("toast-msg");
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    t.hidden = true;
  }, 3200);
}

function downloadPdfReport() {
  if (!activeResultData) {
    showToast("No active interview report to export.");
    return;
  }
  showToast("Preparing your official PDF report...");

  const candidateName = currentUser ? (currentUser.name || "Candidate") : "Candidate";
  const title = activeResultData.title || "Interview Performance Evaluation";
  const safeFilename = `IntervAI_Report_${title.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;

  const posList = (activeResultData.positive_points || activeResultData.positives || [])
    .map((p) => `<li style="margin-bottom: 6px;">${p}</li>`)
    .join("");
  const negList = (activeResultData.negative_points || activeResultData.negatives || [])
    .map((p) => `<li style="margin-bottom: 6px;">${p}</li>`)
    .join("");
  const sugList = (activeResultData.interviewer_suggestions || activeResultData.suggestions || [])
    .map((p) => `<li style="margin-bottom: 6px;">${p}</li>`)
    .join("");

  const baseScore = activeResultData.score != null ? activeResultData.score : 7;
  const comm = activeResultData.communication_score ?? baseScore;
  const tech = activeResultData.technical_score ?? baseScore;
  const conf = activeResultData.confidence_score ?? Math.min(10, baseScore + 1);
  const struct = activeResultData.structure_score ?? baseScore;

  const pdfContainer = document.createElement("div");
  pdfContainer.style.padding = "24px";
  pdfContainer.style.fontFamily = "system-ui, -apple-system, sans-serif";
  pdfContainer.style.color = "#241d17";
  pdfContainer.style.background = "#ffffff";
  pdfContainer.style.lineHeight = "1.5";

  pdfContainer.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #C2492E; padding-bottom: 14px; margin-bottom: 18px;">
      <div>
        <h1 style="margin: 0; color: #C2492E; font-size: 26px; font-weight: 800;">IntervAI</h1>
        <p style="margin: 3px 0 0; color: #736452; font-size: 13px;">Automated Interview Performance & Speech Scorecard</p>
      </div>
      <div style="text-align: right;">
        <span style="display: inline-block; background: #FFF4E5; border: 1.5px solid #C2492E; color: #C2492E; font-weight: 800; font-size: 20px; padding: 6px 18px; border-radius: 8px;">
          Overall: ${activeResultData.score != null ? activeResultData.score : '-'}/10
        </span>
      </div>
    </div>

    <div style="background: #FDF9F3; border: 1px solid #E9DCC8; border-radius: 8px; padding: 12px 16px; margin-bottom: 18px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
      <div><strong>Candidate:</strong> ${candidateName}</div>
      <div><strong>Session:</strong> ${title}</div>
      <div><strong>Date:</strong> ${new Date(activeResultData.createdAt || activeResultData.date || Date.now()).toLocaleDateString()}</div>
      <div><strong>Verified:</strong> Gemini Multi-Modal Engine</div>
    </div>

    <h3 style="color: #34291F; border-bottom: 1px solid #E9DCC8; padding-bottom: 5px; margin: 18px 0 10px; font-size: 16px;">Performance Breakdown</h3>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 18px;">
      <div style="background: #F9F9F9; border: 1px solid #E6E6E6; border-radius: 6px; padding: 10px;">
        <div style="display: flex; justify-content: space-between; font-weight: bold; margin-bottom: 4px; font-size: 13px;">
          <span>🗣️ Communication & Clarity</span>
          <span style="color: #4E6842;">${comm}/10</span>
        </div>
        <div style="width: 100%; height: 6px; background: #E0E0E0; border-radius: 99px;">
          <div style="width: ${comm * 10}%; height: 100%; background: #6E8F5C; border-radius: 99px;"></div>
        </div>
      </div>
      <div style="background: #F9F9F9; border: 1px solid #E6E6E6; border-radius: 6px; padding: 10px;">
        <div style="display: flex; justify-content: space-between; font-weight: bold; margin-bottom: 4px; font-size: 13px;">
          <span>🧠 Technical Depth & Accuracy</span>
          <span style="color: #8C4B22;">${tech}/10</span>
        </div>
        <div style="width: 100%; height: 6px; background: #E0E0E0; border-radius: 99px;">
          <div style="width: ${tech * 10}%; height: 100%; background: #B8622E; border-radius: 99px;"></div>
        </div>
      </div>
      <div style="background: #F9F9F9; border: 1px solid #E6E6E6; border-radius: 6px; padding: 10px;">
        <div style="display: flex; justify-content: space-between; font-weight: bold; margin-bottom: 4px; font-size: 13px;">
          <span>⚡ Confidence & Vocal Pacing</span>
          <span style="color: #93641E;">${conf}/10</span>
        </div>
        <div style="width: 100%; height: 6px; background: #E0E0E0; border-radius: 99px;">
          <div style="width: ${conf * 10}%; height: 100%; background: #C98A2E; border-radius: 99px;"></div>
        </div>
      </div>
      <div style="background: #F9F9F9; border: 1px solid #E6E6E6; border-radius: 6px; padding: 10px;">
        <div style="display: flex; justify-content: space-between; font-weight: bold; margin-bottom: 4px; font-size: 13px;">
          <span>🎯 Answer Structure (STAR)</span>
          <span style="color: #C2492E;">${struct}/10</span>
        </div>
        <div style="width: 100%; height: 6px; background: #E0E0E0; border-radius: 99px;">
          <div style="width: ${struct * 10}%; height: 100%; background: #C2492E; border-radius: 99px;"></div>
        </div>
      </div>
    </div>

    <h3 style="color: #34291F; border-bottom: 1px solid #E9DCC8; padding-bottom: 5px; margin: 18px 0 8px; font-size: 16px;">Executive Evaluation Summary</h3>
    <p style="font-size: 13px; line-height: 1.6; margin: 0 0 16px;">${activeResultData.summary || "No summary recorded."}</p>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px;">
      <div style="background: #F5F9F3; border-left: 4px solid #6E8F5C; padding: 10px 14px; border-radius: 4px;">
        <h4 style="margin: 0 0 6px; color: #4E6842; font-size: 14px;">Key Strengths</h4>
        <ul style="margin: 0; padding-left: 16px; font-size: 12.5px;">${posList || "<li>Good overall delivery</li>"}</ul>
      </div>
      <div style="background: #FCF5F3; border-left: 4px solid #B8622E; padding: 10px 14px; border-radius: 4px;">
        <h4 style="margin: 0 0 6px; color: #8C4B22; font-size: 14px;">Areas for Improvement</h4>
        <ul style="margin: 0; padding-left: 16px; font-size: 12.5px;">${negList || "<li>No major issues flagged</li>"}</ul>
      </div>
    </div>

    <div style="background: #FCF9F2; border-left: 4px solid #C98A2E; padding: 10px 14px; border-radius: 4px; margin-bottom: 16px;">
      <h4 style="margin: 0 0 6px; color: #93641E; font-size: 14px;">Actionable Recommendations</h4>
      <ul style="margin: 0; padding-left: 16px; font-size: 12.5px;">${sugList || "<li>Continue structured interview practice</li>"}</ul>
    </div>

    ${activeResultData.transcript ? `
      <h3 style="color: #34291F; border-bottom: 1px solid #E9DCC8; padding-bottom: 5px; margin: 18px 0 8px; font-size: 15px;">Dialogue Transcript</h3>
      <pre style="white-space: pre-wrap; font-family: monospace; font-size: 11px; background: #F8F8F8; padding: 10px; border-radius: 6px; border: 1px solid #E8E8E8;">${activeResultData.transcript}</pre>
    ` : ""}

    <div style="text-align: center; color: #999; font-size: 11px; margin-top: 24px; border-top: 1px solid #EEE; padding-top: 10px;">
      Generated by IntervAI • Real-Time AI Interview Intelligence Platform
    </div>
  `;

  if (window.html2pdf) {
    const opt = {
      margin: 8,
      filename: safeFilename,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, letterRendering: true },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
    };
    window.html2pdf().set(opt).from(pdfContainer).save().then(() => {
      showToast("✅ PDF report downloaded successfully!");
    }).catch((err) => {
      console.warn("html2pdf failed, invoking native print:", err);
      window.print();
    });
  } else {
    window.print();
  }
}

function copyReportSummary() {
  if (!activeResultData) {
    showToast("No report to copy.");
    return;
  }
  const title = activeResultData.title || "Interview Performance";
  const score = activeResultData.score != null ? activeResultData.score : "-";
  const baseScore = activeResultData.score != null ? activeResultData.score : 7;
  const comm = activeResultData.communication_score ?? baseScore;
  const tech = activeResultData.technical_score ?? baseScore;
  const conf = activeResultData.confidence_score ?? Math.min(10, baseScore + 1);
  const struct = activeResultData.structure_score ?? baseScore;

  const pos = (activeResultData.positive_points || activeResultData.positives || []).map((p) => `• ${p}`).join("\n");
  const neg = (activeResultData.negative_points || activeResultData.negatives || []).map((p) => `• ${p}`).join("\n");
  const sug = (activeResultData.interviewer_suggestions || activeResultData.suggestions || []).map((p) => `• ${p}`).join("\n");

  const text = `🎯 IntervAI Evaluation: ${title}
📊 Overall Score: ${score}/10
- 🗣️ Communication & Clarity: ${comm}/10
- 🧠 Technical Depth & Accuracy: ${tech}/10
- ⚡ Confidence & Vocal Pacing: ${conf}/10
- 🎯 Answer Structure (STAR): ${struct}/10

📝 Executive Summary:
${activeResultData.summary || "N/A"}

✅ Key Strengths:
${pos || "• Good overall response"}

⚠️ Areas for Improvement:
${neg || "• Minor pacing adjustments"}

💡 Actionable Coaching Tips:
${sug || "• Practice structured storytelling"}
`;

  navigator.clipboard.writeText(text).then(() => {
    showToast("📋 Scorecard summary copied to clipboard!");
  }).catch(() => {
    showToast("Could not copy to clipboard.");
  });
}

function shareReport() {
  const title = activeResultData ? activeResultData.title : "Interview Scorecard";
  const scoreText = activeResultData && activeResultData.score != null ? ` (Score: ${activeResultData.score}/10)` : "";
  const shareData = {
    title: `IntervAI - ${title}`,
    text: `Check out my interview performance evaluation report on IntervAI!${scoreText}`,
    url: window.location.href
  };

  if (navigator.share) {
    navigator.share(shareData).catch(() => {});
  } else {
    navigator.clipboard.writeText(window.location.href).then(() => {
      showToast("🔗 Link copied to clipboard!");
    });
  }
}

if ($("btn-download-pdf")) {
  $("btn-download-pdf").addEventListener("click", downloadPdfReport);
}

if ($("btn-copy-summary")) {
  $("btn-copy-summary").addEventListener("click", copyReportSummary);
}

if ($("btn-share-report")) {
  $("btn-share-report").addEventListener("click", shareReport);
}

// ============================================================
// STEP 21: PAST INTERVIEWS
// ============================================================

async function loadPastList() {

  const list =
    $("past-list");

  if (!list) return;

  list.replaceChildren();

  try {

    const res =
      await fetch(
        "/api/interviews",
        {
          headers: getAuthHeaders()
        }
      );

    if (!res.ok) {
      throw new Error(
        "Could not load interviews."
      );
    }

    const items =
      await res.json();


    if ($("past-empty")) {
      $("past-empty").hidden =
        items.length > 0;
    }


    for (const item of items) {

      const li =
        document.createElement(
          "li"
        );

      const btn =
        document.createElement(
          "button"
        );
      btn.className = "past-item-btn";

      const title =
        document.createElement(
          "span"
        );

      const when =
        document.createElement(
          "span"
        );


      title.textContent =
        item.title ||
        "Interview";


      when.className =
        "when";


      when.textContent =
        item.createdAt
          ? new Date(
              item.createdAt
            ).toLocaleDateString()
          : item.date
          ? new Date(
              item.date
            ).toLocaleDateString()
          : "";


      if (item.score != null) {
        const pill = document.createElement("span");
        pill.className = "past-score-pill";
        pill.textContent = `⭐ ${item.score}/10`;
        btn.append(title, pill, when);
      } else {
        btn.append(
          title,
          when
        );
      }


      btn.addEventListener(
        "click",
        () => {
          openPast(
            item.id ||
            item.interview_id
          );
        }
      );


      li.appendChild(btn);

      const delBtn =
        document.createElement(
          "button"
        );
      delBtn.className = "btn-del";
      delBtn.title = "Delete interview";
      delBtn.setAttribute("aria-label", "Delete interview");
      delBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>
      `;
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Are you sure you want to delete this interview record?")) return;
        try {
          const res = await fetch(`/api/interviews/${encodeURIComponent(item.id || item.interview_id)}`, {
            method: "DELETE",
            headers: getAuthHeaders()
          });
          if (!res.ok) throw new Error("Could not delete interview.");
          loadPastList();
        } catch (err) {
          showError(err.message || "Failed to delete interview.");
        }
      });
      li.appendChild(delBtn);

      list.appendChild(li);
    }

  } catch (error) {

    console.error(
      "Past interviews error:",
      error
    );

    showError(
      "Could not load past interviews. Check that the server is running."
    );
  }
}


// ============================================================
// STEP 22: OPEN PAST INTERVIEW
// ============================================================

async function openPast(id) {

  clearError();

  try {

    const res =
      await fetch(
        `/api/interviews/${encodeURIComponent(
          id
        )}`,
        {
          headers: getAuthHeaders()
        }
      );

    if (!res.ok) {
      throw new Error(
        "Could not open this interview."
      );
    }

    const item =
      await res.json();

    renderResult({
      ...item,

      title:
        item.title ||
        "Interview",

      createdAt:
        item.createdAt ||
        item.date ||
        new Date().toISOString()
    });

  } catch (error) {

    console.error(
      "Open interview error:",
      error
    );

    showError(
      error.message ||
      "Could not open interview."
    );
  }
}


// ============================================================
// STEP 23: USER AUTHENTICATION CONTROLLER
// ============================================================

let authToken = localStorage.getItem("intervai_token") || null;
let currentUser = null;
try {
  currentUser = JSON.parse(localStorage.getItem("intervai_user") || "null");
} catch (_) {
  currentUser = null;
}
let currentAuthMode = "login";

function getAuthHeaders() {
  const headers = {};
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return headers;
}

function updateAuthUI() {
  const guestBox = $("auth-nav-guest");
  const userBox = $("auth-nav-user");
  const greeting = $("user-greeting");
  const modal = $("auth-modal");

  if (currentUser) {
    // Authenticated: Unlock the app
    document.body.classList.remove("auth-locked");
    if (modal) {
      modal.classList.remove("mandatory");
      modal.hidden = true;
    }
    if (guestBox) guestBox.hidden = true;
    if (userBox) userBox.hidden = false;
    if (greeting) {
      const displayName = currentUser.name ? currentUser.name.split(" ")[0] : "User";
      greeting.textContent = `👤 ${displayName}`;
      const badge = $("welcome-badge-text");
      if (badge) {
        badge.textContent = `👋 Welcome back, ${displayName}! Your AI Interview Coach is ready.`;
      }
    }
  } else {
    // Unauthenticated: Lock the entire app behind Login!
    document.body.classList.add("auth-locked");
    if (modal) {
      modal.classList.add("mandatory");
      modal.hidden = false;
      showAuthPanel("welcome", false);
    }
    const badge = $("welcome-badge-text");
    if (badge) {
      badge.textContent = "AI-Powered Interview Coach & Performance Analytics";
    }
    if (guestBox) guestBox.hidden = false;
    if (userBox) userBox.hidden = true;
  }
}

let isAuthTransitioning = false;

function showAuthPanel(panelName, animated = true) {
  const welcomePanel = $("auth-panel-welcome");
  const formPanel = $("auth-panel-form");
  if (!welcomePanel || !formPanel) return;

  const currentPanel = !formPanel.hidden ? "form" : "welcome";
  if (currentPanel === panelName && !isAuthTransitioning) return;
  if (isAuthTransitioning) return;

  if (!animated) {
    if (panelName === "form") {
      welcomePanel.hidden = true;
      welcomePanel.classList.remove("slide-out-left", "slide-in-left", "slide-out-right", "slide-in-right");
      formPanel.hidden = false;
      formPanel.classList.remove("slide-out-left", "slide-in-left", "slide-out-right", "slide-in-right");
      const emailInput = $("auth-input-email");
      if (emailInput) emailInput.focus();
    } else {
      formPanel.hidden = true;
      formPanel.classList.remove("slide-out-left", "slide-in-left", "slide-out-right", "slide-in-right");
      welcomePanel.hidden = false;
      welcomePanel.classList.remove("slide-out-left", "slide-in-left", "slide-out-right", "slide-in-right");
    }
    return;
  }

  isAuthTransitioning = true;
  const duration = 250; // ms

  if (panelName === "form") {
    welcomePanel.classList.remove("slide-in-left", "slide-in-right", "slide-out-right");
    welcomePanel.classList.add("slide-out-left");

    setTimeout(() => {
      welcomePanel.hidden = true;
      welcomePanel.classList.remove("slide-out-left");

      formPanel.hidden = false;
      formPanel.classList.remove("slide-out-left", "slide-out-right", "slide-in-left");
      formPanel.classList.add("slide-in-right");

      const emailInput = $("auth-input-email");
      if (emailInput) emailInput.focus();
      isAuthTransitioning = false;
    }, duration);
  } else {
    formPanel.classList.remove("slide-in-left", "slide-in-right", "slide-out-left");
    formPanel.classList.add("slide-out-right");

    setTimeout(() => {
      formPanel.hidden = true;
      formPanel.classList.remove("slide-out-right");

      welcomePanel.hidden = false;
      welcomePanel.classList.remove("slide-out-left", "slide-out-right", "slide-in-right");
      welcomePanel.classList.add("slide-in-left");
      isAuthTransitioning = false;
    }, duration);
  }
}

async function verifyAuthSession() {
  if (!authToken) {
    currentUser = null;
    updateAuthUI();
    return;
  }
  try {
    const res = await fetch("/api/auth/me", {
      headers: getAuthHeaders()
    });
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      localStorage.setItem("intervai_user", JSON.stringify(currentUser));
    } else {
      logoutUser(false);
    }
  } catch (_) {
    // network glitch, retain cached user session
  }
  updateAuthUI();
}

function setAuthMode(mode) {
  currentAuthMode = mode;
  const isSignup = mode === "signup";

  const tabLogin = $("tab-auth-login");
  const tabSignup = $("tab-auth-signup");
  const fieldName = $("auth-field-name");
  const title = $("auth-title");
  const submitBtn = $("btn-auth-submit");
  const prompt = $("auth-footer-prompt");
  const errBox = $("auth-error");
  const succBox = $("auth-success");

  if (errBox) errBox.hidden = true;
  if (succBox) succBox.hidden = true;

  if (tabLogin) {
    tabLogin.classList.toggle("active", !isSignup);
    tabLogin.setAttribute("aria-selected", String(!isSignup));
  }
  if (tabSignup) {
    tabSignup.classList.toggle("active", isSignup);
    tabSignup.setAttribute("aria-selected", String(isSignup));
  }
  if (fieldName) {
    fieldName.hidden = !isSignup;
    const nameInput = $("auth-input-name");
    if (nameInput) nameInput.required = isSignup;
  }
  if (title) {
    title.textContent = isSignup ? "Create an Account" : "Sign In to IntervAI";
  }
  if (submitBtn) {
    submitBtn.textContent = isSignup ? "Create Account" : "Sign In";
  }
  if (prompt) {
    prompt.innerHTML = isSignup
      ? 'Already have an account? <button type="button" id="btn-switch-signup" class="auth-switch-link">Sign in</button>'
      : 'Don\'t have an account? <button type="button" id="btn-switch-signup" class="auth-switch-link">Sign up</button>';
    const switchBtn = $("btn-switch-signup");
    if (switchBtn) {
      switchBtn.addEventListener("click", () => {
        setAuthMode(currentAuthMode === "login" ? "signup" : "login");
      });
    }
  }
}

function openAuthModal(mode = "login", directToForm = false) {
  const modal = $("auth-modal");
  if (!modal) return;
  setAuthMode(mode);
  if (!currentUser) {
    document.body.classList.add("auth-locked");
    modal.classList.add("mandatory");
  } else {
    modal.classList.remove("mandatory");
  }
  modal.hidden = false;

  if (directToForm) {
    showAuthPanel("form", false);
  } else {
    showAuthPanel("welcome", false);
  }
}

function closeAuthModal() {
  // Bina login ke modal band nahi ho sakta
  if (!currentUser) return;
  const modal = $("auth-modal");
  if (modal) {
    modal.classList.remove("mandatory");
    modal.hidden = true;
  }
}

function loginSuccess(token, user) {
  authToken = token;
  currentUser = user;
  localStorage.setItem("intervai_token", token);
  localStorage.setItem("intervai_user", JSON.stringify(user));
  updateAuthUI();
  closeAuthModal();
  loadPastList();
}

function logoutUser(shouldReload = true) {
  authToken = null;
  currentUser = null;
  localStorage.removeItem("intervai_token");
  localStorage.removeItem("intervai_user");
  updateAuthUI();
  openAuthModal("login");
  if (shouldReload) {
    const list = $("past-list");
    if (list) list.replaceChildren();
    if ($("past-empty")) $("past-empty").hidden = false;
  }
}

// Bind auth UI events
if ($("btn-open-login")) {
  $("btn-open-login").addEventListener("click", () => openAuthModal("login"));
}

if ($("btn-logout")) {
  $("btn-logout").addEventListener("click", () => logoutUser());
}

if ($("btn-close-auth")) {
  $("btn-close-auth").addEventListener("click", closeAuthModal);
}

if ($("btn-auth-explore")) {
  $("btn-auth-explore").addEventListener("click", () => {
    showAuthPanel("form", true);
  });
}

if ($("btn-back-to-robo")) {
  $("btn-back-to-robo").addEventListener("click", () => {
    showAuthPanel("welcome", true);
  });
}

const authOverlay = $("auth-modal");
if (authOverlay) {
  authOverlay.addEventListener("click", (e) => {
    // If not logged in, clicking backdrop will NOT close modal
    if (!currentUser) return;
    if (e.target === authOverlay) closeAuthModal();
  });
}

if ($("tab-auth-login")) {
  $("tab-auth-login").addEventListener("click", () => setAuthMode("login"));
}

if ($("tab-auth-signup")) {
  $("tab-auth-signup").addEventListener("click", () => setAuthMode("signup"));
}

const authForm = $("auth-form");
if (authForm) {
  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errBox = $("auth-error");
    const succBox = $("auth-success");
    const submitBtn = $("btn-auth-submit");

    if (errBox) errBox.hidden = true;
    if (succBox) succBox.hidden = true;

    const email = $("auth-input-email") ? $("auth-input-email").value.trim() : "";
    const password = $("auth-input-password") ? $("auth-input-password").value : "";
    const name = $("auth-input-name") ? $("auth-input-name").value.trim() : "";

    const isSignup = currentAuthMode === "signup";
    const endpoint = isSignup ? "/api/auth/register" : "/api/auth/login";
    const payload = isSignup ? { name, email, password } : { email, password };

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Please wait...";
    }

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.message || (isSignup ? "Sign up failed." : "Login failed."));
      }

      if (succBox) {
        succBox.textContent = data.message || "Success!";
        succBox.hidden = false;
      }

      setTimeout(() => {
        loginSuccess(data.token, data.user);
      }, 500);
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message || "Authentication failed.";
        errBox.hidden = false;
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = isSignup ? "Create Account" : "Sign In";
      }
    }
  });
}

// Initial session check and UI update
updateAuthUI();
verifyAuthSession();

// ============================================================
// APP START
// ============================================================

console.log(
  "Interview AI frontend with authentication loaded successfully."
);