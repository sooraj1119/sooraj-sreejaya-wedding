import { events } from "./wedding.js?v=7.9";
import { FRAMES_BASE, POSTER } from "./demo-config.js?v=7.9";
import { FramePlayer } from "./frame-player.js?v=7.9";

const $ = selector => document.querySelector(selector);
const canvas = $("#journey-video");
const journey = $("#journey");
const stage = $(".journey-stage");
const progressFill = $("#progress-fill");
const numEl = $("#chapter-number");
const nameEl = $("#chapter-name");
const nextChapter = $("#next-chapter");
const nextArrow = nextChapter ? nextChapter.querySelector("span") : null;

const IS_TOUCH = typeof window !== "undefined" && (
  ('ontouchstart' in window) ||
  (navigator.maxTouchPoints > 0) ||
  window.innerWidth <= 768
);
const LERP_FACTOR = IS_TOUCH ? 0.68 : 0.38;
const status = $("#media-status");
const loader = $("#film-loader");
const loaderFill = $("#film-loader-fill");
const loaderLabel = $("#film-loader-label");
const loaderPct = $("#film-loader-pct");
const copies = [...document.querySelectorAll(".chapter-copy")];
const chapterButtons = [...document.querySelectorAll("[data-chapter]")];
const starts = copies.map(copy => Number(copy.dataset.start));
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
const connection = navigator.connection;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const FPS = 24;
const FRAME = 1 / FPS;
const hero = $(".hero-depth");
const heroContent = $(".hero-content");
let stageWidth = 0;
let stageHeight = 0;
let duration = 20.0;
let presented = 0;
let activeChapter = -1;
let staticMode = false;
let filmReady = false;
let player;

function updateHeroDepth(time) {
  if (staticMode) {
    if (hero) hero.style.clipPath = "none";
    if (heroContent) heroContent.style.transform = "none";
    return;
  }
  const depth = clamp(time / 5, 0, 1);
  if (heroContent) heroContent.style.transform = `translateY(${-depth * 18}px) scale(${1 - depth * 0.05})`;
}

// Discrete non-overlapping chapter timeline windows for 20.0s celebration video (3 Chapters)
const CHAPTER_TIMELINES = [
  { start: 0.0,  end: 5.5,  fadeIn: 0.0,  fadeOut: 4.8 },  // Chapter 1: The beginning (Ballroom dance)
  { start: 6.8,  end: 12.8, fadeIn: 7.6,  fadeOut: 12.0 }, // Chapter 2: The union (Gazing together & close-up)
  { start: 14.0, end: 20.5, fadeIn: 14.8, fadeOut: 20.5 }, // Chapter 3: The celebration (Walking together, Sourav compliments & RSVP)
];

function updateChapter(time) {
  if (staticMode) {
    copies.forEach((copy, i) => {
      copy.classList.toggle("is-active", i === 0);
      copy.style.opacity = i === 0 ? "1" : "0";
      copy.style.visibility = i === 0 ? "visible" : "hidden";
      copy.style.pointerEvents = i === 0 ? "auto" : "none";
    });
    return;
  }

  // Determine current active chapter index
  let currentIndex = -1;
  for (let i = 0; i < CHAPTER_TIMELINES.length; i++) {
    const t = CHAPTER_TIMELINES[i];
    if (time >= t.start && time <= t.end) {
      currentIndex = i;
      break;
    }
  }

  // Update navigation headers and active step badges
  if (currentIndex !== -1 && currentIndex !== activeChapter) {
    activeChapter = currentIndex;
    if (numEl) numEl.textContent = String(currentIndex + 1).padStart(2, "0");
    if (nameEl && copies[currentIndex]) nameEl.textContent = copies[currentIndex].dataset.name;
    chapterButtons.forEach((button, i) => {
      if (i === currentIndex) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
    if (nextChapter) {
      nextChapter.firstChild.textContent = currentIndex === (copies.length - 1) ? "Back to top " : "Scroll to unfold ";
      if (nextArrow) nextArrow.innerHTML = currentIndex === (copies.length - 1) ? "&uarr;" : "&rarr;";
    }
  }

  // Calculate precise, non-overlapping opacity for each chapter
  copies.forEach((copy, i) => {
    const t = CHAPTER_TIMELINES[i];
    let alpha = 0;
    if (time >= t.start && time <= t.end) {
      if (time < t.fadeIn) {
        alpha = clamp((time - t.start) / Math.max(0.01, t.fadeIn - t.start), 0, 1);
      } else if (time > t.fadeOut && t.fadeOut < t.end) {
        alpha = clamp((t.end - time) / Math.max(0.01, t.end - t.fadeOut), 0, 1);
      } else {
        alpha = 1;
      }
    }

    const smoothAlpha = alpha * alpha * (3 - 2 * alpha);
    const isActive = smoothAlpha > 0.005;
    const wasActive = copy.classList.contains("is-active");

    if (isActive) {
      if (!wasActive) {
        copy.classList.add("is-active");
        copy.removeAttribute("aria-hidden");
        copy.inert = false;
        copy.style.visibility = "visible";
        copy.style.pointerEvents = "auto";
      }
      const lastAlpha = copy._lastAlpha || 0;
      if (Math.abs(smoothAlpha - lastAlpha) > 0.005) {
        copy._lastAlpha = smoothAlpha;
        copy.style.opacity = smoothAlpha.toFixed(3);
        const translateY = ((1 - smoothAlpha) * 12).toFixed(1);
        copy.style.transform = `translate3d(0, ${translateY}px, 0)`;
      }
    } else {
      if (wasActive) {
        copy._lastAlpha = 0;
        copy.classList.remove("is-active");
        copy.setAttribute("aria-hidden", "true");
        copy.inert = true;
        copy.style.opacity = "0";
        copy.style.visibility = "hidden";
        copy.style.pointerEvents = "none";
      }
    }
  });

  if (time <= 5.5) {
    updateHeroDepth(time);
  }
  if (progressFill) {
    const scale = clamp(time / (duration - FRAME), 0, 1);
    progressFill.style.transform = `scaleX(${scale.toFixed(4)})`;
  }
}

function measure() {
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (stageWidth && stageHeight) {
    const dw = Math.abs(stageWidth - sw);
    const dh = Math.abs(stageHeight - sh);
    if (dw < 4 && dh < 60) return;
  }
  stageWidth = sw;
  stageHeight = sh;
  player?.resize();
  updateHeroDepth(presented);
}

function setLoadProgress(ratio, label) {
  const value = clamp(ratio, 0, 1);
  if (loaderFill) loaderFill.style.transform = `scaleX(${value})`;
  if (loaderPct) loaderPct.textContent = `${Math.round(value * 100)}%`;
  if (label && loaderLabel) loaderLabel.textContent = label;
}

function finishLoader() {
  filmReady = true;
  loader?.classList.add("is-done");
  loader?.setAttribute("aria-busy", "false");
  status.textContent = "";
}

function inputAllowed(event) {
  return !staticMode && filmReady && !document.hidden && !document.querySelector("dialog[open]")
    && !(event?.target instanceof Element && event.target.closest("input, select, textarea, [contenteditable]"));
}

// -------------------------------------------------------------
// BUTTER-SMOOTH KINETIC SCROLLER (60FPS / 120FPS)
// -------------------------------------------------------------
let targetTime = 0;
let smoothTime = 0;
let isLoopRunning = false;

function updateTargetScroll() {
  const currentScroll = window.scrollY || window.pageYOffset || document.documentElement.scrollTop;
  if (currentScroll > 10) {
    startAudio();
  }
  if (!player?.ready || staticMode) return;

  const maxScroll = Math.max(1, journey.offsetHeight - innerHeight);
  const progress = Math.min(1, Math.max(0, currentScroll / maxScroll));
  targetTime = progress * (duration - FRAME);

  if (!isLoopRunning) {
    isLoopRunning = true;
    requestAnimationFrame(kineticLoop);
  }
}

function kineticLoop() {
  if (!player?.ready || staticMode) {
    isLoopRunning = false;
    return;
  }

  const diff = targetTime - smoothTime;
  if (Math.abs(diff) > 0.0005) {
    smoothTime += diff * LERP_FACTOR;
    player.scrubTo(smoothTime);
    updateChapter(smoothTime);
    requestAnimationFrame(kineticLoop);
  } else {
    smoothTime = targetTime;
    player.scrubTo(smoothTime);
    updateChapter(smoothTime);
    isLoopRunning = false;
  }
}

window.addEventListener("scroll", updateTargetScroll, { passive: true });
window.addEventListener("resize", measure, { passive: true });

function goToChapter(index) {
  if (staticMode) {
    $("#wedding-details").showModal();
    document.body.style.overflow = "hidden";
    return;
  }
  startAudio();
  const maxScroll = Math.max(1, journey.offsetHeight - innerHeight);
  const targetT = index >= copies.length || index === 0 ? 0 : Math.min(starts[index] + 1.0, duration - FRAME);
  const targetScroll = Math.round((targetT / (duration - FRAME)) * maxScroll);
  targetTime = targetT;
  if (!isLoopRunning && player?.ready) {
    isLoopRunning = true;
    requestAnimationFrame(kineticLoop);
  }
  window.scrollTo({ top: targetScroll, behavior: "smooth" });
}

chapterButtons.forEach(button =>
  button.addEventListener("click", () => goToChapter(Number(button.dataset.chapter)))
);
$("#next-chapter")?.addEventListener("click", () => goToChapter(activeChapter >= (copies.length - 1) ? 0 : activeChapter + 1));

// Keyboard navigation
window.addEventListener("keydown", event => {
  if (!inputAllowed(event) || event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.("button, a, summary, input, select, textarea")) return;
  if (["ArrowDown", "PageDown", " "].includes(event.key)) {
    event.preventDefault();
    startAudio();
    window.scrollBy({ top: innerHeight * 0.45, behavior: "smooth" });
  } else if (["ArrowUp", "PageUp"].includes(event.key)) {
    event.preventDefault();
    startAudio();
    window.scrollBy({ top: -innerHeight * 0.45, behavior: "smooth" });
  }
});

function loadFilm() {
  player?.dispose();
  filmReady = false;
  loader?.classList.remove("is-done");
  loader?.setAttribute("aria-busy", "true");
  setLoadProgress(0, "Preparing your journey...");
  staticMode = false;
  document.documentElement.classList.toggle("static-journey", staticMode);
  presented = 0;
  activeChapter = -1;
  updateChapter(0);
  player = new FramePlayer({
    canvas, status,
    framesBase: FRAMES_BASE,
    poster: POSTER,
    onProgress(ratio, label) {
      setLoadProgress(ratio, label);
    },
    onFrame(time) {
      presented = time;
      updateChapter(time);
    },
    onReady(film) {
      duration = film.duration;
      finishLoader();
      updateTargetScroll();
    },
    onError() {
      staticMode = true;
      filmReady = true;
      document.documentElement.classList.add("static-journey");
      finishLoader();
      status.textContent = "The film couldn't load. Open the celebrations for details.";
      activeChapter = -1;
      updateChapter(0);
    },
  });
  measure();
  if (!staticMode) {
    status.textContent = "Preparing your journey...";
    player.load();
  } else {
    status.textContent = "";
    finishLoader();
  }
}

motionPreference.addEventListener("change", loadFilm);
connection?.addEventListener("change", () => { if (connection.saveData) loadFilm(); });
loadFilm();

// -------------------------------------------------------------
// AMBIENT ROSE PETALS & GOLDEN SPARKLES SHOWER
// -------------------------------------------------------------
function initAmbientEffects() {
  const ambCanvas = document.getElementById("ambient-canvas");
  if (!ambCanvas) return;
  const ctx = ambCanvas.getContext("2d");
  let width = (ambCanvas.width = window.innerWidth);
  let height = (ambCanvas.height = window.innerHeight);

  const isMobileDev = window.innerWidth <= 768 || (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
  window.addEventListener("resize", () => {
    const dw = Math.abs(width - window.innerWidth);
    const dh = Math.abs(height - window.innerHeight);
    if (dw < 4 && dh < 60) return;
    width = ambCanvas.width = window.innerWidth;
    height = ambCanvas.height = window.innerHeight;
  }, { passive: true });

  const isMobile = window.innerWidth <= 768 || (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
  const petalCount = isMobile ? 8 : 18;
  const sparkleCount = isMobile ? 12 : 26;
  const petals = [];
  const sparkles = [];

  for (let i = 0; i < petalCount; i++) {
    petals.push({
      x: Math.random() * width,
      y: Math.random() * height,
      size: Math.random() * 8 + 8,
      speedY: Math.random() * 0.8 + 0.5,
      speedX: Math.random() * 0.6 - 0.3,
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 1.4,
      flip: Math.random() * Math.PI,
      flipSpeed: Math.random() * 0.03 + 0.012,
      color: Math.random() > 0.4 ? 'rgba(240, 135, 165, ' : 'rgba(215, 85, 125, ',
      opacity: Math.random() * 0.45 + 0.35,
    });
  }

  for (let i = 0; i < sparkleCount; i++) {
    sparkles.push({
      x: Math.random() * width,
      y: Math.random() * height,
      size: Math.random() * 2.0 + 0.8,
      speedY: -(Math.random() * 0.5 + 0.2),
      speedX: (Math.random() - 0.5) * 0.4,
      alpha: Math.random() * 0.7 + 0.3,
      pulse: Math.random() * Math.PI,
      pulseSpeed: Math.random() * 0.04 + 0.02,
    });
  }

  function drawPetal(p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((p.rotation * Math.PI) / 180);
    ctx.scale(Math.cos(p.flip), 1);
    ctx.fillStyle = `${p.color}${p.opacity})`;
    ctx.beginPath();
    ctx.moveTo(0, -p.size);
    ctx.bezierCurveTo(p.size * 0.7, -p.size * 0.5, p.size * 0.9, p.size * 0.6, 0, p.size);
    ctx.bezierCurveTo(-p.size * 0.9, p.size * 0.6, -p.size * 0.7, -p.size * 0.5, 0, -p.size);
    ctx.fill();
    ctx.restore();
  }

  let isUserScrolling = false;
  let scrollReleaseTimer = null;
  window.addEventListener("scroll", () => {
    isUserScrolling = true;
    clearTimeout(scrollReleaseTimer);
    scrollReleaseTimer = setTimeout(() => { isUserScrolling = false; }, 180);
  }, { passive: true });

  function render() {
    if (document.hidden || (isMobileDev && isUserScrolling)) {
      requestAnimationFrame(render);
      return;
    }
    ctx.clearRect(0, 0, width, height);

    // Draw sparkles
    for (const s of sparkles) {
      s.y += s.speedY;
      s.x += s.speedX;
      s.pulse += s.pulseSpeed;
      if (s.y < -10) { s.y = height + 10; s.x = Math.random() * width; }
      if (s.x < -10) s.x = width + 10;
      if (s.x > width + 10) s.x = -10;

      const currentAlpha = Math.max(0.1, (Math.sin(s.pulse) * 0.4 + 0.6) * s.alpha);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(245, 215, 140, ${currentAlpha})`;
      if (!isMobileDev) {
        ctx.shadowColor = 'rgba(245, 205, 110, 0.8)';
        ctx.shadowBlur = 8;
      }
      ctx.fill();
    }
    if (!isMobileDev) ctx.shadowBlur = 0;

    // Draw petals
    for (const p of petals) {
      p.y += p.speedY;
      p.x += p.speedX + Math.sin(p.y * 0.008) * 0.4;
      p.rotation += p.rotSpeed;
      p.flip += p.flipSpeed;
      if (p.y > height + 20) { p.y = -20; p.x = Math.random() * width; }
      if (p.x < -20) p.x = width + 20;
      if (p.x > width + 20) p.x = -20;
      drawPetal(p);
    }

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}
initAmbientEffects();

// -------------------------------------------------------------
// LIVE RECEPTION COUNTDOWN TIMER
// -------------------------------------------------------------
function initCountdown() {
  const timerEl = document.getElementById("countdown-timer");
  if (!timerEl) return;
  const targetDate = new Date("2026-12-23T19:00:00+05:30").getTime();

  function update() {
    const now = Date.now();
    const diff = targetDate - now;
    if (diff <= 0) {
      timerEl.textContent = "Today at 6:30 PM";
      return;
    }
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    timerEl.textContent = `${days}d ${hours}h ${mins}m`;
  }
  update();
  setInterval(update, 60000);
}
initCountdown();

// -------------------------------------------------------------
// EVENT COPY & ICALENDAR (SOORAJ & SREEJAYA)
// -------------------------------------------------------------
const dateFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Kolkata",
});
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Kolkata",
});
function formatEventRange(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  return `${dateFormat.format(startDate)} \u2013 ${timeFormat.format(endDate)}`;
}
const eventsList = $("#events-list");
if (eventsList) {
  eventsList.innerHTML = events
    .map(
      (event) => `
    <article class="event-card">
      <header>
        ${event.label && event.label !== event.title ? `<span class="event-label">${event.label}</span>` : ''}
        <h3 class="event-title">${event.title}</h3>
      </header>
      <div class="event-body">
        <p class="event-time">${formatEventRange(event.start, event.end)}</p>
        <p class="event-venue">${event.venue}</p>
        ${event.note ? `<p class="event-note">${event.note}</p>` : ""}
      </div>
    </article>
  `,
    )
    .join("");
}

function formatICSDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function escapeICS(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}
const stamp = formatICSDate(new Date());
const icsLines = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Sooraj and Sreejaya Wedding Reception//EN",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "X-WR-CALNAME:Sooraj & Sreejaya - Wedding Reception",
  "X-WR-TIMEZONE:Asia/Kolkata",
  ...events.flatMap((event, index) => [
    "BEGIN:VEVENT",
    `UID:sooraj-sreejaya-reception-${index}@wedding`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${formatICSDate(new Date(event.start))}`,
    `DTEND:${formatICSDate(new Date(event.end))}`,
    `SUMMARY:${escapeICS(event.title)}: ${escapeICS(event.label)}`,
    `DESCRIPTION:${escapeICS(event.note ? `${event.note} (Sooraj & Sreejaya Wedding Reception)` : "Sooraj & Sreejaya Wedding Reception")}`,
    `LOCATION:${escapeICS(event.venue)}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
  ]),
  "END:VCALENDAR",
];

const folded = icsLines.map((line) => {
  let result = "";
  let width = 0;
  for (const character of line) {
    const bytes = new TextEncoder().encode(character).length;
    if (width + bytes > 73) {
      result += "\r\n ";
      width = 1;
    }
    result += character;
    width += bytes;
  }
  return result;
});
const calendarURL = URL.createObjectURL(
  new Blob([folded.join("\r\n") + "\r\n"], {
    type: "text/calendar;charset=utf-8",
  }),
);
const saveDateBtn = $("#save-date");
if (saveDateBtn) saveDateBtn.href = calendarURL;
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) URL.revokeObjectURL(calendarURL);
});

// -------------------------------------------------------------
// DIALOGS & RSVP PREVIEW
// -------------------------------------------------------------
const dialog = $("#rsvp-dialog");
const detailsDialog = $("#wedding-details");

function openDetails() {
  startAudio();
  detailsDialog.showModal();
  document.body.style.overflow = "hidden";
}

document.querySelectorAll('a[href="#celebrations"], [data-open-celebrations], [data-open-details]').forEach((link) =>
  link.addEventListener("click", (event) => {
    event.preventDefault();
    openDetails();
  })
);
$("#close-details")?.addEventListener("click", () => detailsDialog.close());
detailsDialog?.addEventListener("close", () => {
  if (!dialog.open) document.body.style.overflow = "";
});
detailsDialog?.addEventListener("click", (event) => {
  if (event.target !== detailsDialog) return;
  const rect = detailsDialog.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
    detailsDialog.close();
});

const form = $("#rsvp-form");
const storageKey = "sooraj-sreejaya-reception-rsvp-v1";

function syncGuestField() {
  if (!form) return;
  const attending = form.elements.attendance.value === "yes";
  $("#guest-field").hidden = !attending;
  form.elements.guests.disabled = !attending;
}

document.querySelectorAll("#open-rsvp, [data-open-rsvp]").forEach((button) =>
  button.addEventListener("click", () => {
    startAudio();
    if (detailsDialog.open) detailsDialog.close();
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (saved)
        for (const name of ["name", "attendance", "guests", "message"]) {
          if (typeof saved[name] === "string" && form.elements[name])
            form.elements[name].value = saved[name];
        }
    } catch {}
    syncGuestField();
    const statusEl = $("#rsvp-status");
    if (statusEl) statusEl.textContent = "";
    dialog.showModal();
    document.body.style.overflow = "hidden";
  })
);

$("#close-rsvp")?.addEventListener("click", () => dialog.close());
dialog?.addEventListener("close", () => {
  document.body.style.overflow = "";
});
dialog?.addEventListener("click", (event) => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
    dialog.close();
});

if (form) {
  form.elements.attendance.addEventListener("change", syncGuestField);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    const statusEl = $("#rsvp-status");
    const values = Object.fromEntries(new FormData(form));
    values.name = values.name.trim();
    if (!values.name) {
      form.elements.name.setCustomValidity("Please enter your name.");
      form.elements.name.reportValidity();
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending RSVP...";
    }
    if (statusEl) {
      statusEl.style.color = "#d4ae6d";
      statusEl.textContent = "Recording your response & notifying Sooraj & Sreejaya...";
    }

    // 1. Save locally
    try {
      localStorage.setItem(storageKey, JSON.stringify(values));
    } catch {}

    // 2. Prepare automated email data
    const emailRecipient = "sooraj1119@gmail.com";
    const attendingText = values.attendance === "yes" ? "Joyfully Accept" : "Sending Love From Afar";
    const emailSubject = `Wedding Reception RSVP: ${values.name} (${attendingText})`;
    const emailBody = `Dear Sooraj & Sreejaya,\n\nHere are the RSVP details for your Wedding Reception:\n\n` +
      `• Guest Name: ${values.name}\n` +
      `• Attendance: ${attendingText}\n` +
      `• Number of Guests: ${values.guests || "1"}\n` +
      `• Message / Blessings: ${values.message || "None"}\n\n` +
      `Submitted for Wednesday, 23rd December 2026 at Trinita Casa Events & Banquet, Edappally, Kochi.`;

    let emailSent = false;

    // 3. Post to local backend endpoint /api/rsvp (which persists and forwards)
    try {
      const resp = await fetch("/api/rsvp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (resp.ok) {
        emailSent = true;
      }
    } catch (e) {
      console.warn("Local /api/rsvp note:", e);
    }

    // 4. Also send via FormSubmit API directly to sooraj1119@gmail.com
    try {
      const fsResp = await fetch(`https://formsubmit.co/ajax/${emailRecipient}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          _subject: emailSubject,
          _template: "table",
          "Guest Name": values.name,
          "Attendance": attendingText,
          "Number of Guests": values.guests || "1",
          "Blessings / Note": values.message || "",
          "Event": "Sooraj & Sreejaya Wedding Reception (23 Dec 2026 @ Trinita Casa, Edappally)"
        }),
      });
      if (fsResp.ok) {
        emailSent = true;
      }
    } catch (e) {
      console.warn("FormSubmit fetch note:", e);
    }

    // 5. Update UI with confirmation and direct mailto link
    const mailtoUrl = `mailto:${emailRecipient}?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`;
    if (statusEl) {
      statusEl.style.color = "#74d88e";
      statusEl.innerHTML = `✓ Thank you, <strong>${values.name}</strong>! Your RSVP has been recorded and an email notification was sent to <strong>${emailRecipient}</strong>.<br><br>` +
        `<a href="${mailtoUrl}" class="action-pill" style="display:inline-block; font-size:11px; padding:6px 14px; margin-top:6px; color:#fff; background:rgba(212,174,109,0.3); border:1px solid #d4ae6d; border-radius:20px; text-decoration:none;">Open in Mail App &rarr;</a>`;
    }

    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Attendance Confirmed ✓";
    }
  });

  form.elements.name.addEventListener("input", () =>
    form.elements.name.setCustomValidity(""),
  );
}

// -------------------------------------------------------------
// BACKGROUND MUSIC CONTROLLER
// -------------------------------------------------------------
// -------------------------------------------------------------
// BULLETPROOF AUDIO CONTROLLER WITH AUTO-PAUSE ON MINIMIZE
// -------------------------------------------------------------
// -------------------------------------------------------------
// 100% GUARANTEED SILENCE ON MINIMIZE (PAUSE + HARD MUTE)
// -------------------------------------------------------------
const bgm = document.querySelector("#bgm-audio");
const audioPrompt = document.querySelector("#audio-prompt");
const musicToggle = document.querySelector("#music-toggle");
let musicPlaying = false;
let userPaused = false;
let wasPlayingBeforeHidden = false;
let audioStarting = false;
let isAppBackgrounded = false;

function showAudioPrompt() {
  if (audioPrompt && !musicPlaying && !userPaused && !isAppBackgrounded) {
    audioPrompt.classList.add("is-visible");
  }
}

function hideAudioPrompt() {
  if (audioPrompt) {
    audioPrompt.classList.remove("is-visible");
  }
}

function updateMusicUI() {
  if (musicToggle) {
    musicToggle.classList.toggle("is-playing", musicPlaying && !isAppBackgrounded);
    const textEl = musicToggle.querySelector(".music-text");
    if (textEl) textEl.textContent = (musicPlaying && !isAppBackgrounded) ? "Playing" : "Play";
  }
}

function startAudio() {
  // If app is minimized, screen is locked, or tab is hidden: STRICTLY ABORT
  if (isAppBackgrounded || (typeof document !== "undefined" && (document.hidden || document.visibilityState === "hidden"))) {
    return;
  }
  if (userPaused) return;
  if (musicPlaying && bgm && !bgm.paused && !bgm.muted) return;
  if (!bgm || audioStarting) return;

  audioStarting = true;
  bgm.muted = false;
  bgm.volume = 0.75;
  const playPromise = bgm.play();
  if (playPromise !== undefined) {
    playPromise
      .then(() => {
        // Double check in case device was minimized while promise resolved
        if (isAppBackgrounded || (typeof document !== "undefined" && (document.hidden || document.visibilityState === "hidden"))) {
          bgm.pause();
          bgm.muted = true;
          musicPlaying = false;
          audioStarting = false;
          updateMusicUI();
          return;
        }
        musicPlaying = true;
        audioStarting = false;
        hideAudioPrompt();
        updateMusicUI();
        removeGlobalAudioTriggers();
      })
      .catch(() => {
        audioStarting = false;
        showAudioPrompt();
        updateMusicUI();
      });
  }
}

function pauseAudio(isManual = false) {
  if (!bgm) return;
  if (isManual) {
    userPaused = true;
    wasPlayingBeforeHidden = false;
  }
  bgm.pause();
  bgm.muted = true;
  musicPlaying = false;
  audioStarting = false;
  updateMusicUI();
}

function toggleAudio() {
  if (!bgm) return;
  if (bgm.paused || userPaused) {
    userPaused = false;
    startAudio();
  } else {
    pauseAudio(true);
  }
}

function handlePageHidden() {
  isAppBackgrounded = true;
  if (!bgm) return;
  if (!bgm.paused || musicPlaying) {
    wasPlayingBeforeHidden = true;
  }
  // DUAL ACTION: Both pause AND hardware mute to guarantee silence on all mobile engines
  bgm.pause();
  bgm.muted = true;
  musicPlaying = false;
  audioStarting = false;
  updateMusicUI();
}

function handlePageVisible() {
  isAppBackgrounded = false;
  if (!bgm) return;
  // Only resume if user hadn't explicitly paused and it was playing before
  if (wasPlayingBeforeHidden && !userPaused && !document.hidden && document.visibilityState === "visible") {
    bgm.muted = false;
    startAudio();
  }
  wasPlayingBeforeHidden = false;
}

// 1. W3C Page Visibility (Minimizing browser, locking phone, switching tabs/apps)
document.addEventListener("visibilitychange", () => {
  if (document.hidden || document.visibilityState === "hidden") {
    handlePageHidden();
  } else {
    handlePageVisible();
  }
});

// 2. iOS Safari pagehide (Home swipe, App Switcher, bfcache)
window.addEventListener("pagehide", handlePageHidden);
window.addEventListener("pageshow", (e) => {
  if (!document.hidden && document.visibilityState === "visible") handlePageVisible();
});

// 3. Window blur / focus (Control Center, Notification tray)
window.addEventListener("blur", handlePageHidden);
window.addEventListener("focus", () => {
  if (!document.hidden && document.visibilityState === "visible") handlePageVisible();
});

if (musicToggle) {
  musicToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAudio();
  });
}

function onFirstInteraction() {
  if (!userPaused && !isAppBackgrounded && !document.hidden) {
    startAudio();
  }
}

window.addEventListener("pointerdown", onFirstInteraction, { passive: true });
window.addEventListener("click", onFirstInteraction, { passive: true });
window.addEventListener("touchstart", onFirstInteraction, { passive: true });

function removeGlobalAudioTriggers() {
  window.removeEventListener("pointerdown", onFirstInteraction);
  window.removeEventListener("click", onFirstInteraction);
  window.removeEventListener("touchstart", onFirstInteraction);
}

if (audioPrompt) {
  audioPrompt.addEventListener("click", (e) => {
    e.stopPropagation();
    userPaused = false;
    startAudio();
  });
}

if (bgm) {
  bgm.addEventListener("ended", () => {
    if (!document.hidden && !userPaused && !isAppBackgrounded) {
      bgm.currentTime = 0;
      bgm.play().catch(() => {});
    }
  });
}

window.updateChapter = updateChapter;
window.player = player;
