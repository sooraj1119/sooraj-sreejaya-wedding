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
let scrollStart = 0;
let scrollDistance = 1;
let expectedScrollY = window.scrollY;
let touch = null;
let pinch = false;
let currentGestureDirection = 0;
const heldKeys = new Set();
let keyTimer;
const isTouch =
  matchMedia('(pointer: coarse)').matches || innerWidth < 900;
const GESTURE_GRACE = isTouch ? 1100 : 700;
const SCROLL_SLACK = isTouch ? 72 : 36;

// Coordinate-only mask: no second video or canvas is decoded on the phone.
fetch(SKYLINE)
  .then((response) => {
    if (!response.ok) throw new Error("Mask unavailable");
    return response.json();
  })
  .then((data) => {
    skyline = data;
    updateHeroDepth(presented);
  })
  .catch(() => {
    /* The readable hero remains available if the effect fails. */
  });

function updateHeroDepth(time) {
  if (staticMode) {
    hero.style.clipPath = "none";
    heroContent.style.transform = "none";
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
  hero.style.clipPath = `polygon(${points.join(",")})`;
  const depth = clamp(time / 5, 0, 1);
  heroContent.style.transform = `translateY(${-depth * 18}px) scale(${1 - depth * 0.06})`;
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
    $("#chapter-number").textContent = String(index + 1).padStart(2, "0");
    $("#chapter-name").textContent = copies[index].dataset.name;
    activeChapter = index;
    $("#next-chapter").firstChild.textContent = staticMode
      ? "The celebrations "
      : index === 5
        ? "Back to the beginning "
        : "Scroll to unfold ";
    $("#next-chapter span").textContent = index === 5 ? "↑" : "↓";
  }
  // Fade around the actual scene boundaries, tied to the frame that has decoded.
  const fadeIn = index === 0 ? 1 : clamp((time - starts[index]) / 0.65, 0, 1);
  const fadeOut =
    index === copies.length - 1
      ? 1
      : clamp((starts[index + 1] - time) / 0.65, 0, 1);
  const alpha = staticMode ? 1 : Math.min(fadeIn, fadeOut);
  copies[index].style.opacity = String(alpha * alpha * (3 - 2 * alpha));
  updateHeroDepth(time);
  $("#progress-fill").style.transform =
    `scaleX(${staticMode ? 0 : clamp(time / (duration - FRAME), 0, 1)})`;
}


function measure() {
  scrollStart = journey.offsetTop;
  stageWidth = stage.clientWidth;
  stageHeight = stage.clientHeight;
  scrollDistance = Math.max(1, journey.offsetHeight - innerHeight);
  player?.resize();
  updateHeroDepth(presented);
}

function syncScroll() {
  if (staticMode) return;
  expectedScrollY = Math.round(scrollStart + presented / (duration - FRAME) * scrollDistance);
  const drift = scrollY - expectedScrollY;
  if (Math.abs(drift) > SCROLL_SLACK) {
    window.scrollTo({ top: expectedScrollY, behavior: "instant" });
  }
}

function stopPlayback() {
  player?.stop();
  heldKeys.clear();
  clearInterval(keyTimer);
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
  startAudio();
}

function inputAllowed(event) {
  return !staticMode && filmReady && !document.hidden && !document.querySelector("dialog[open]")
    && !(event?.target instanceof Element && event.target.closest("input, select, textarea, [contenteditable]"));
}

function receiveIntent(direction) {
  if (!direction || !inputAllowed()) return;
  player?.intent(direction, GESTURE_GRACE);
}

function loadFilm() {
  player?.dispose();
  filmReady = false;
  loader?.classList.remove("is-done");
  loader?.setAttribute("aria-busy", "true");
  setLoadProgress(0, "Preparing your journey…");
  staticMode = motionPreference.matches || !!connection?.saveData;
  document.documentElement.classList.toggle("static-journey", staticMode);
  const restoredPosition = clamp((scrollY - journey.offsetTop) / Math.max(1, journey.offsetHeight - innerHeight), 0, 1);
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
      syncScroll();
    },
    onReady(film) {
      duration = film.duration;
      finishLoader();
      if (restoredPosition > .001) film.seek(restoredPosition * (duration - FRAME));
    },
    onError() {
      stopPlayback();
      staticMode = true;
      filmReady = true;
      document.documentElement.classList.add("static-journey");
      finishLoader();
      status.textContent = "The film couldn’t load. Open the celebrations for details.";
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

// There is one gesture controller for wheels, trackpads, and touch. Input
// changes direction and extends a short deadline; it never changes film speed.
window.addEventListener("wheel", event => {
  if (!inputAllowed(event) || event.ctrlKey || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  event.preventDefault();
  receiveIntent(Math.sign(event.deltaY));
  if (Math.abs(event.deltaY) > 80) receiveIntent(Math.sign(event.deltaY));
}, { passive: false });

function touchSample(touches) {
  const points = [...touches];
  const x = points.reduce((sum, point) => sum + point.clientX, 0) / points.length;
  const y = points.reduce((sum, point) => sum + point.clientY, 0) / points.length;
  const span = points.length === 2 ? Math.hypot(points[0].clientX - points[1].clientX, points[0].clientY - points[1].clientY) : 0;
  return { x, y, span, count: points.length };
}

stage.addEventListener("touchstart", event => {
  if (!inputAllowed(event) || event.touches.length > 2) return;
  touch = touchSample(event.touches);
  pinch = false;
  currentGestureDirection = 0;
}, { passive: true });

stage.addEventListener("touchmove", event => {
  if (!touch || !inputAllowed(event) || !event.touches.length || event.touches.length > 2) return;
  const next = touchSample(event.touches);
  if (next.count !== touch.count) { touch = next; return; }
  // A two-finger parallel swipe uses the same centroid as one finger. A pinch
  // is left to the browser so zoom remains available.
  if (next.count === 2 && Math.abs(next.span - touch.span) > 5) {
    pinch = true;
    stopPlayback();
  }
  if (pinch) { touch = next; return; }
  const dy = touch.y - next.y;
  const dx = touch.x - next.x;
  if (Math.abs(dy) >= Math.abs(dx) && Math.abs(dy) >= 1) {
    if (event.cancelable) event.preventDefault();
    currentGestureDirection = Math.sign(dy);
    receiveIntent(currentGestureDirection);
    if (Math.abs(dy) > 12) receiveIntent(currentGestureDirection);
  }
  touch = next;
}, { passive: false });

stage.addEventListener("touchend", event => {
  if (event.touches.length) { touch = touchSample(event.touches); return; }
  if (!pinch && currentGestureDirection) receiveIntent(currentGestureDirection);
  touch = null;
  pinch = false;
  currentGestureDirection = 0;
}, { passive: true });
stage.addEventListener("touchcancel", () => {
  touch = null;
  pinch = false;
  currentGestureDirection = 0;
  stopPlayback();
}, { passive: true });

window.addEventListener("keydown", event => {
  if (!inputAllowed(event) || event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.("button, a, summary")) return;
  let direction = ["ArrowDown", "PageDown", "End"].includes(event.key) ? 1 : ["ArrowUp", "PageUp", "Home"].includes(event.key) ? -1 : 0;
  if (event.code === "Space") direction = event.shiftKey ? -1 : 1;
  if (!direction) return;
  event.preventDefault();
  heldKeys.add(event.code);
  receiveIntent(direction);
  clearInterval(keyTimer);
  keyTimer = setInterval(() => receiveIntent(direction), 150);
});
window.addEventListener("keyup", event => {
  if (!heldKeys.delete(event.code)) return;
  if (!heldKeys.size) stopPlayback();
});
window.addEventListener("scroll", () => {
  if (!player?.ready || staticMode) return;
  const delta = scrollY - expectedScrollY;
  if (Math.abs(delta) <= 2) return;
  if (inputAllowed()) receiveIntent(Math.sign(delta));
  syncScroll();
}, { passive: true });
window.addEventListener("resize", measure, { passive: true });
window.addEventListener("pageshow", measure);
window.addEventListener("blur", stopPlayback);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPlayback();
  else measure();
});
motionPreference.addEventListener("change", loadFilm);
connection?.addEventListener("change", () => { if (connection.saveData) loadFilm(); });
new ResizeObserver(measure).observe(stage);

function goToChapter(index) {
  stopPlayback();
  if (staticMode) {
    $("#wedding-details").showModal();
    document.body.style.overflow = "hidden";
    return;
  }
  player.seek(index >= copies.length || index === 0 ? 0 : starts[index] + .9);
}
chapterButtons.forEach(button => button.addEventListener("click", () => goToChapter(Number(button.dataset.chapter))));
$("#next-chapter").addEventListener("click", () => goToChapter(activeChapter + 1));
loadFilm();

// Event copy and the calendar use the same editable data.
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
  date.textContent = `${dateFormat.format(new Date(event.start))} · ${timeFormat.format(new Date(event.start))}`;
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
    `UID:sooraj-sreejaya-2026-${i}@wedding.example`,
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
// Fold at UTF-8-safe boundaries for calendar readers (RFC 5545).
const encoder = new TextEncoder();
const folded = calendar.map((line) => {
  let result = "",
    width = 0;
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
$("#save-date").href = calendarURL;
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) URL.revokeObjectURL(calendarURL);
});

// Honest local RSVP preview. Native dialog supplies focus containment and Escape.
const dialog = $("#rsvp-dialog");
const detailsDialog = $("#wedding-details");
document.querySelectorAll('a[href="#celebrations"]').forEach((link) =>
  link.addEventListener("click", (event) => {
    event.preventDefault();
    stopPlayback();
    detailsDialog.showModal();
    document.body.style.overflow = "hidden";
  }),
);
$("#close-details").addEventListener("click", () => detailsDialog.close());
detailsDialog.addEventListener("close", () => {
  if (!dialog.open) document.body.style.overflow = "";
});
const form = $("#rsvp-form");
const storageKey = "sooraj-sreejaya-rsvp-preview-v1";
function syncGuestField() {
  const attending = form.elements.attendance.value === "yes";
  $("#guest-field").hidden = !attending;
  form.elements.guests.disabled = !attending;
}
document.querySelectorAll("#open-rsvp, [data-open-rsvp]").forEach((button) =>
  button.addEventListener("click", () => {
    stopPlayback();
    if (detailsDialog.open) detailsDialog.close();
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (saved)
        for (const name of ["name", "attendance", "guests", "message"]) {
          if (typeof saved[name] === "string")
            form.elements[name].value = saved[name];
        }
    } catch {
      /* Storage may be unavailable; the form still works for this session. */
    }
    syncGuestField();
    $("#rsvp-status").textContent = "";
    dialog.showModal();
    document.body.style.overflow = "hidden";
  }),
);
$("#close-rsvp").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  document.body.style.overflow = "";
});
dialog.addEventListener("click", (event) => {
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
      `Thank you, ${values.name}. Your preview reply is saved on this device. Nothing has been sent to the couple.`;
  } catch {
    $("#rsvp-status").textContent =
      "Your browser couldn’t save this preview. Nothing has been sent to the couple.";
  }
});
form.elements.name.addEventListener("input", () =>
  form.elements.name.setCustomValidity(""),
);

// ==========================================================
// BACKGROUND MUSIC CONTROLLER (ALWAYS-ON AMBIENCE)
// ==========================================================
const bgm = document.querySelector("#bgm-audio");
const audioToggle = document.querySelector("#audio-toggle");
let isAudioPlaying = false;
let userMuted = false;

function updateAudioUI(playing) {
  isAudioPlaying = playing;
  if (!audioToggle) return;
  audioToggle.classList.toggle("is-playing", playing);
  audioToggle.setAttribute("aria-label", playing ? "Mute background music" : "Play background music");
  audioToggle.title = playing ? "Mute Music" : "Play Music";
  const text = audioToggle.querySelector(".audio-text");
  if (text) text.textContent = playing ? "Music on" : "Music muted";
}

function startAudio() {
  if (!bgm || userMuted) return;
  bgm.volume = 0.75;
  const playPromise = bgm.play();
  if (playPromise !== undefined) {
    playPromise
      .then(() => {
        updateAudioUI(true);
      })
      .catch(() => {
        updateAudioUI(false);
      });
  }
}

function toggleAudio() {
  if (!bgm) return;
  if (isAudioPlaying) {
    userMuted = true;
    bgm.pause();
    updateAudioUI(false);
  } else {
    userMuted = false;
    startAudio();
  }
}

if (audioToggle) {
  audioToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAudio();
  });
}

// Always ensure music is playing on every interaction (scroll, click, touch, key)
function ensureAudioAlwaysPlaying() {
  if (!userMuted && bgm && bgm.paused) {
    startAudio();
  }
}

["pointerdown", "touchstart", "scroll", "wheel", "keydown", "click"].forEach((event) => {
  window.addEventListener(event, ensureAudioAlwaysPlaying, { passive: true });
});

// Guard loop: if song ends or pauses unexpectedly, loop immediately
if (bgm) {
  bgm.addEventListener("ended", () => {
    bgm.currentTime = 0;
    if (!userMuted) bgm.play().catch(() => {});
  });
}

// Immediate initial start attempt on load
startAudio();