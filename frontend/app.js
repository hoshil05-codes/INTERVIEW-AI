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


function renderResult(data) {

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


      btn.append(
        title,
        when
      );


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
    }
  } else {
    // Unauthenticated: Lock the entire app behind Login!
    document.body.classList.add("auth-locked");
    if (modal) {
      modal.classList.add("mandatory");
      modal.hidden = false;
    }
    if (guestBox) guestBox.hidden = false;
    if (userBox) userBox.hidden = true;
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

function openAuthModal(mode = "login") {
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
  const emailInput = $("auth-input-email");
  if (emailInput) emailInput.focus();
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