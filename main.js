import { events } from "./wedding.js";
import { FRAMES_BASE, POSTER, SKYLINE } from "./demo-config.js";
import { FramePlayer } from "./frame-player.js";

const $ = selector => document.querySelector(selector);
const canvas = $("#journey-video");
const journey = $("#journey");
const stage = $(".journey-stage");
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
let skyline = null;
let stageWidth = 0;
let stageHeight = 0;
let duration = 50.416667;
let presented = 0;
let activeChapter = -1;
let staticMode = false;
let filmReady = false;
let player;

// Coordinate-only mask for hero skyline clip-path
fetch(SKYLINE)
  .then((response) => {
    if (!response.ok) throw new Error("Mask unavailable");
    return response.json();
  })
  .then((data) => {
    skyline = data;
    updateHeroDepth(presented);
  })
  .catch(() => {});

function updateHeroDepth(time) {
  if (staticMode) {
    if (hero) hero.style.clipPath = "none";
    if (heroContent) heroContent.style.transform = "none";
    return;
  }
  if (!skyline || time >= starts[1] || !stageWidth) return;
  const boundary =
    skyline.frames[
      Math.min(skyline.frames.length - 1, Math.floor(time * skyline.fps + 0.01))
    ];
  const scale = Math.max(
    stageWidth / skyline.width,
    stageHeight / skyline.height,
  );
  const offsetX = (stageWidth - skyline.width * scale) / 2;
  const offsetY = (stageHeight - skyline.height * scale) / 2;
  const right = offsetX + skyline.width * scale;
  const points = [`${offsetX}px ${offsetY}px`, `${right}px ${offsetY}px`];
  for (let x = boundary.length - 1; x >= 0; x--) {
    points.push(
      `${(offsetX + (x + 0.5) * scale).toFixed(2)}px ${(offsetY + boundary[x] * scale).toFixed(2)}px`,
    );
  }
  if (hero) hero.style.clipPath = "none";
  const depth = clamp(time / 5, 0, 1);
  if (heroContent) heroContent.style.transform = `translateY(${-depth * 18}px) scale(${1 - depth * 0.06})`;
}

function updateChapter(time) {
  const index = staticMode
    ? 0
    : Math.max(
        0,
        starts.findLastIndex((start) => time >= start),
      );
  if (index !== activeChapter) {
    copies.forEach((copy, i) => {
      copy.classList.toggle("is-active", i === index);
      copy.setAttribute("aria-hidden", String(i !== index));
      copy.inert = i !== index;
      if (i !== index) copy.style.opacity = "0";
    });
    chapterButtons.forEach((button, i) => {
      if (i === index) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
    const numEl = $("#chapter-number");
    const nameEl = $("#chapter-name");
    if (numEl) numEl.textContent = String(index + 1).padStart(2, "0");
    if (nameEl && copies[index]) nameEl.textContent = copies[index].dataset.name;
    activeChapter = index;
    const nextChapter = $("#next-chapter");
    if (nextChapter) {
      nextChapter.firstChild.textContent = staticMode
        ? "The celebrations "
        : index === 5
          ? "Back to the beginning "
          : "Scroll to unfold ";
      const arrow = nextChapter.querySelector("span");
      if (arrow) arrow.textContent = index === 5 ? "↑" : "→";
    }
  }

  // Fade around scene boundaries
  const fadeIn = index === 0 ? 1 : clamp((time - starts[index]) / 0.65, 0, 1);
  const fadeOut =
    index === copies.length - 1
      ? 1
      : clamp((starts[index + 1] - time) / 0.65, 0, 1);
  const alpha = staticMode ? 1 : Math.min(fadeIn, fadeOut);
  if (copies[index]) {
    copies[index].style.opacity = String(alpha * alpha * (3 - 2 * alpha));
  }
  updateHeroDepth(time);
  const progressFill = $("#progress-fill");
  if (progressFill) {
    progressFill.style.transform =
      `scaleX(${staticMode ? 0 : clamp(time / (duration - FRAME), 0, 1)})`;
  }
}

function measure() {
  stageWidth = stage.clientWidth;
  stageHeight = stage.clientHeight;
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
// HIGH-PERFORMANCE BUTTER-SMOOTH KINETIC SCROLLER (60FPS / 120FPS)
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

  // Smooth exponential dampening (Lerp) for butter-smooth camera movement
  const diff = targetTime - smoothTime;
  if (Math.abs(diff) < 0.0006) {
    smoothTime = targetTime;
    presented = smoothTime;
    player.scrubTo(smoothTime);
    updateChapter(smoothTime);
    isLoopRunning = false;
    return;
  }

  smoothTime += diff * 0.22;
  presented = smoothTime;
  player.scrubTo(smoothTime);
  updateChapter(smoothTime);

  requestAnimationFrame(kineticLoop);
}

// Native hardware-accelerated scroll listener
window.addEventListener('scroll', updateTargetScroll, { passive: true });
window.addEventListener('resize', measure, { passive: true });
window.addEventListener('pageshow', measure);
new ResizeObserver(measure).observe(stage);

function goToChapter(index) {
  if (staticMode) {
    $("#wedding-details").showModal();
    document.body.style.overflow = "hidden";
    return;
  }
  startAudio();
  const maxScroll = Math.max(1, journey.offsetHeight - innerHeight);
  const targetTime = index >= copies.length || index === 0 ? 0 : starts[index] + 0.1;
  const targetScroll = Math.round((targetTime / (duration - FRAME)) * maxScroll);
  window.scrollTo({ top: targetScroll, behavior: "smooth" });
}

chapterButtons.forEach(button =>
  button.addEventListener("click", () => goToChapter(Number(button.dataset.chapter)))
);
$("#next-chapter")?.addEventListener("click", () => goToChapter(activeChapter >= 5 ? 0 : activeChapter + 1));

// Keyboard smooth navigation
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
  setLoadProgress(0, "Preparing your journey…");
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
    status.textContent = "Preparing your journey…";
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
// EVENT COPY & ICALENDAR (SOORAJ & SREEJAYA)
// -------------------------------------------------------------
const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  timeZone: "Asia/Kolkata",
});
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Kolkata",
});
const list = $("#events-list");
if (list) {
  list.replaceChildren();
  events.forEach((event, i) => {
    const item = document.createElement("article");
    item.className = "event";
    const number = document.createElement("span");
    number.className = "event-number";
    number.textContent = `${String(i + 1).padStart(2, "0")} /`;
    const copy = document.createElement("div");
    const date = document.createElement("p");
    date.className = "small-label";
    date.textContent = `${dateFormat.format(new Date(event.start))} • ${timeFormat.format(new Date(event.start))}`;
    const title = document.createElement("h3");
    title.textContent = event.title;
    const label = document.createElement("p");
    label.textContent = event.label;
    copy.append(date, title, label);
    const details = document.createElement("div");
    details.className = "event-details";
    const venue = document.createElement("p");
    venue.textContent = event.venue;
    const note = document.createElement("span");
    note.textContent = event.note;
    details.append(venue, note);
    item.append(number, copy, details);
    list.append(item);
  });
}

const escapeICS = (s) =>
  s
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
const utcStamp = (date) =>
  new Date(date)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
const calendar = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Sooraj and Sreejaya//Wedding Invitation//EN",
  "CALSCALE:GREGORIAN",
];
events.forEach((event, i) => {
  calendar.push(
    "BEGIN:VEVENT",
    `UID:sooraj-sreejaya-2026-${i}@wedding.local`,
    "DTSTAMP:20261019T000000Z",
    `DTSTART:${utcStamp(event.start)}`,
    `DTEND:${utcStamp(event.end)}`,
    `SUMMARY:${escapeICS(`Sooraj & Sreejaya - ${event.label}`)}`,
    `LOCATION:${escapeICS(`${event.venue}, Kadavanthra, Kochi`)}`,
    "DESCRIPTION:Auspicious wedding ceremony of Sooraj & Sreejaya.",
    "END:VEVENT",
  );
});
calendar.push("END:VCALENDAR");

const encoder = new TextEncoder();
const folded = calendar.map((line) => {
  let result = "", width = 0;
  for (const character of line) {
    const bytes = encoder.encode(character).length;
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
document.querySelectorAll('a[href="#celebrations"]').forEach((link) =>
  link.addEventListener("click", (event) => {
    event.preventDefault();
    startAudio();
    detailsDialog.showModal();
    document.body.style.overflow = "hidden";
  }),
);
$("#close-details")?.addEventListener("click", () => detailsDialog.close());
detailsDialog?.addEventListener("close", () => {
  if (!dialog.open) document.body.style.overflow = "";
});
const form = $("#rsvp-form");
const storageKey = "sooraj-sreejaya-rsvp-preview-v1";
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
  }),
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
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    values.name = values.name.trim();
    if (!values.name) {
      form.elements.name.setCustomValidity("Please enter your name.");
      form.elements.name.reportValidity();
      return;
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(values));
      $("#rsvp-status").textContent =
        `Thank you, ${values.name}. Your blessings and attendance have been recorded.`;
    } catch {
      $("#rsvp-status").textContent =
        "Your reply is recorded for this session. Thank you!";
    }
  });
  form.elements.name.addEventListener("input", () =>
    form.elements.name.setCustomValidity(""),
  );
}

// -------------------------------------------------------------
// BACKGROUND MUSIC CONTROLLER
// -------------------------------------------------------------
const bgm = document.querySelector("#bgm-audio");
const audioPrompt = document.querySelector("#audio-prompt");
let musicPlaying = false;

function showAudioPrompt() {
  if (audioPrompt && !musicPlaying) {
    audioPrompt.classList.add("is-visible");
  }
}

function hideAudioPrompt() {
  if (audioPrompt) {
    audioPrompt.classList.remove("is-visible");
  }
}

function startAudio() {
  if (musicPlaying && bgm && !bgm.paused) return;
  if (!bgm) return;
  bgm.volume = 0.75;
  const playPromise = bgm.play();
  if (playPromise !== undefined) {
    playPromise
      .then(() => {
        musicPlaying = true;
        hideAudioPrompt();
      })
      .catch(() => {
        showAudioPrompt();
      });
  }
}

window.addEventListener("pointerdown", startAudio, { passive: true });
window.addEventListener("click", startAudio, { passive: true });
window.addEventListener("touchstart", startAudio, { passive: true });
window.addEventListener("touchend", startAudio, { passive: true });

if (audioPrompt) {
  audioPrompt.addEventListener("click", (e) => {
    e.stopPropagation();
    startAudio();
  });
}

if (bgm) {
  bgm.addEventListener("ended", () => {
    bgm.currentTime = 0;
    bgm.play().catch(() => {});
  });
}

// -------------------------------------------------------------
// AUTO-PAUSE ON MINIMIZE / BACKGROUND / APP SWITCH
// -------------------------------------------------------------
let wasPlayingBeforeHidden = false;

document.addEventListener("visibilitychange", () => {
  if (!bgm) return;
  if (document.hidden) {
    wasPlayingBeforeHidden = musicPlaying && !bgm.paused;
    if (wasPlayingBeforeHidden) {
      bgm.pause();
      musicPlaying = false;
      
    }
  } else {
    if (wasPlayingBeforeHidden) {
      startAudio();
    }
  }
});

window.addEventListener("pagehide", () => {
  if (bgm && !bgm.paused) {
    wasPlayingBeforeHidden = true;
    bgm.pause();
    musicPlaying = false;
    
  }
});

window.addEventListener("pageshow", () => {
  if (wasPlayingBeforeHidden && !document.hidden) {
    startAudio();
  }
});
