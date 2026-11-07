// Ultra-Smooth Butter-Scroller Frame Player with Native Image Decoding & High-Throughput LRU Cache
const IS_MOBILE = typeof window !== "undefined" && (
  window.innerWidth <= 768 ||
  (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) ||
  /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "")
);

// Performance & Memory Tuned:
// Mobile: 640x360 frames (1920x720 sheet = 5.5MB). 12 cached sheets = 66MB RAM (well below 280MB iOS ceiling, but generous enough for zero stutter).
// Desktop: 1280x720 HD frames (3840x1440 sheet = 22MB). 18 cached sheets.
const PREFETCH_FRAMES = IS_MOBILE ? 36 : 48; // Mobile: 6 sheets ahead (1.5s); Desktop: 8 sheets ahead (2.0s)
const INITIAL_WARM_SHEETS = IS_MOBILE ? 4 : 6;
const MAX_CACHE_SHEETS = IS_MOBILE ? 12 : 18;
const MAX_CONCURRENT = IS_MOBILE ? 3 : 5;

class FrameSheets {
  constructor(manifest, variant, framesBase, onLoad, onError) {
    this.framesBase = framesBase;
    this.manifest = manifest;
    this.variant = variant;
    this.info = manifest.variants[variant] || manifest.variants["desktop"];
    this.perSheet = manifest.columns * manifest.rows;
    this.prefetchSheets = Math.min(
      this.info.sheets,
      Math.ceil(PREFETCH_FRAMES / this.perSheet),
    );
    this.cache = new Map();
    this.loading = new Map();
    this.failures = new Map();
    this.wanted = [];
    this.bootstrapEnd = 0;
    this.onLoad = onLoad;
    this.onError = onError;
    this.closed = false;
    this.backgroundWarming = false;
  }

  sheetUrl(index) {
    return `${this.framesBase}/${this.variant}/${String(index).padStart(3, "0")}.webp?v=7.7`;
  }

  bootstrap() {
    this.bootstrapEnd = this.prefetchSheets;
    this.pump();
  }

  clearBootstrap(atSheet) {
    if (atSheet >= this.bootstrapEnd - 1) this.bootstrapEnd = 0;
  }

  focus(sheet, direction = 1) {
    const dir = direction || 1;
    const wanted = [];
    // Priority 1: Current target sheet
    if (sheet >= 0 && sheet < this.info.sheets) wanted.push(sheet);
    // Priority 2: Forward lookahead
    for (let i = 1; i <= this.prefetchSheets; i++) {
      const idx = sheet + i * dir;
      if (idx >= 0 && idx < this.info.sheets) wanted.push(idx);
    }
    // Priority 3: Backward one sheet
    const behind = sheet - dir;
    if (behind >= 0 && behind < this.info.sheets && !wanted.includes(behind)) {
      wanted.push(behind);
    }
    this.wanted = wanted;

    // Instantly abort downloads that are no longer wanted to free connections for active scroll target
    for (const [idx, controller] of this.loading) {
      if (!this.wanted.includes(idx) && idx >= this.bootstrapEnd) {
        controller.abort();
        this.loading.delete(idx);
      }
    }

    this.evictExcess();
    this.pump();
  }

  evictExcess() {
    if (this.cache.size <= MAX_CACHE_SHEETS) return;
    for (const [index, image] of this.cache) {
      if (!this.wanted.includes(index) && index >= this.bootstrapEnd) {
        if (image) {
          try {
            image.onload = null;
            image.onerror = null;
            image.src = "";
            if (typeof image.close === "function") image.close();
          } catch {}
        }
        this.cache.delete(index);
        if (this.cache.size <= MAX_CACHE_SHEETS) break;
      }
    }
    // Hard clamp if rapid scrubbing exceeds memory budget
    if (this.cache.size > MAX_CACHE_SHEETS) {
      for (const [index, image] of this.cache) {
        if (!this.wanted.slice(0, 3).includes(index)) {
          if (image) {
            try {
              image.onload = null;
              image.onerror = null;
              image.src = "";
              if (typeof image.close === "function") image.close();
            } catch {}
          }
          this.cache.delete(index);
          if (this.cache.size <= MAX_CACHE_SHEETS) break;
        }
      }
    }
  }

  // Always return the closest available cached frame to ensure the canvas NEVER stalls or freezes
  getClosestCached(targetSheet) {
    if (this.cache.has(targetSheet)) return this.cache.get(targetSheet);
    let best = null;
    let minDiff = Infinity;
    for (const [sheetIdx, image] of this.cache) {
      const diff = Math.abs(sheetIdx - targetSheet);
      if (diff < minDiff) {
        minDiff = diff;
        best = image;
      }
    }
    return best;
  }

  maxConcurrent() {
    return MAX_CONCURRENT;
  }

  pump() {
    if (this.closed) return;
    const queue = [...new Set([...this.wanted, ...this.bootstrapIndices()])];
    for (const index of queue) {
      if (this.loading.size >= this.maxConcurrent()) break;
      if (
        this.cache.has(index) ||
        this.loading.has(index) ||
        this.failures.get(index) >= 3
      )
        continue;
      const controller = new AbortController();
      this.loading.set(index, controller);
      this.load(index, controller);
    }
  }

  bootstrapIndices() {
    if (!this.bootstrapEnd) return [];
    return Array.from({ length: this.bootstrapEnd }, (_, index) => index);
  }

  async load(index, controller) {
    if (this.closed || controller.signal.aborted) return;
    try {
      const img = new Image();
      img.decoding = "async";
      img.crossOrigin = "anonymous";
      
      const loadPromise = new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });
      const abortHandler = () => {
        try {
          img.onload = null;
          img.onerror = null;
          img.src = "";
        } catch {}
      };
      controller.signal.addEventListener("abort", abortHandler, { once: true });
      img.src = this.sheetUrl(index);

      if (typeof img.decode === "function") {
        try {
          await img.decode();
        } catch {
          await loadPromise;
        }
      } else {
        await loadPromise;
      }

      if (this.closed || controller.signal.aborted) {
        img.onload = null;
        img.onerror = null;
        img.src = "";
        return;
      }

      img.close = () => {
        img.onload = null;
        img.onerror = null;
        img.src = "";
      };

      this.cache.set(index, img);
      this.onLoad();
    } catch (error) {
      if (!controller.signal.aborted && !this.closed) {
        const count = (this.failures.get(index) || 0) + 1;
        this.failures.set(index, count);
        if (count >= 3) this.onError(error);
      }
    } finally {
      this.loading.delete(index);
      this.pump();
    }
  }

  // Gentle background prewarm into browser HTTP disk cache
  startBackgroundWarm() {
    // Skip on mobile to prevent network saturation and cellular latency
    if (IS_MOBILE || this.backgroundWarming || this.closed) return;
    this.backgroundWarming = true;
    const total = this.info.sheets;
    let next = INITIAL_WARM_SHEETS;
    const concurrency = IS_MOBILE ? 1 : 2;
    const runWorker = async () => {
      while (!this.closed) {
        const idx = next++;
        if (idx >= total) break;
        try {
          const img = new Image();
          img.src = this.sheetUrl(idx);
        } catch {}
        await new Promise(r => setTimeout(r, IS_MOBILE ? 140 : 80));
      }
    };
    for (let c = 0; c < concurrency; c++) {
      runWorker();
    }
  }

  dispose() {
    this.closed = true;
    for (const request of this.loading.values()) request.abort();
    for (const image of this.cache.values()) {
      try { if (image && typeof image.close === "function") image.close(); } catch {}
    }
    this.cache.clear();
  }
}

export class FramePlayer {
  constructor({
    canvas,
    status,
    framesBase = "public/assets/frames",
    poster,
    onFrame,
    onReady,
    onError,
    onProgress,
  }) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.framesBase = framesBase;
    this.status = status;
    this.onFrame = onFrame;
    this.onReady = onReady;
    this.onError = onError;
    this.onProgress = onProgress;
    this.time = 0;
    this.direction = 0;
    this.coarse = matchMedia("(pointer: coarse)").matches || innerWidth < 900;
    this.rate = this.coarse ? 2.5 : 2.2;
    this.boost = 1;
    this.lastIntent = 0;
    this.frame = -1;
    this.raf = 0;
    this.until = 0;
    this.lastTick = 0;
    this.pendingJump = null;
    this.ready = false;
    this.lastCanvasW = 0;
    this.lastCanvasH = 0;
    if (poster) {
      this.poster = new Image();
      this.poster.src = poster;
      this.poster.onload = () => {
        if (this.frame < 0) this.drawPoster();
      };
    }
    this.resize();
  }

  async warmInitial(onProgress) {
    const total = Math.min(this.info.sheets, INITIAL_WARM_SHEETS);
    let done = 0;
    let next = 0;
    const run = async () => {
      while (!this.closed) {
        const index = next++;
        if (index >= total) break;
        try {
          const img = new Image();
          img.src = this.store.sheetUrl(index);
          if (typeof img.decode === "function") await img.decode();
        } catch {}
        done += 1;
        onProgress?.(done / total);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT, total) }, () => run())
    );
  }

  async load() {
    try {
      this.onProgress?.(0.1, "Preparing your journey...");
      const response = await fetch(`${this.framesBase}/manifest.json?v=7.4`, { cache: "no-store" });
      if (!response.ok) throw new Error("Frame manifest unavailable");
      const manifest = await response.json();
      if (this.closed) return;
      this.fps = manifest.fps;
      this.perSheet = manifest.columns * manifest.rows;
      this.columns = manifest.columns;
      
      this.variant = IS_MOBILE ? "mobile" : "desktop";
      this.info = manifest.variants[this.variant] || manifest.variants["desktop"];
      this.duration = this.info.count / this.fps;
      this.end = (this.info.count - 1) / this.fps;
      this.store = new FrameSheets(
        manifest,
        this.variant,
        this.framesBase,
        () => this.onSheet(),
        (error) => this.fail(error),
      );
      this.resize();

      this.onProgress?.(0.3, "Loading memories...");
      await this.warmInitial((ratio) => {
        this.onProgress?.(0.3 + ratio * 0.6, "Loading memories...");
      });

      this.store.bootstrap();
      await this.waitForInitialFrame();
      this.ready = true;
      this.onProgress?.(1, "");
      this.onReady?.({ duration: this.duration, fps: this.fps });

      // Start gentle background warming into HTTP cache
      this.store.startBackgroundWarm();
    } catch (error) {
      this.fail(error);
    }
  }

  waitForInitialFrame() {
    return new Promise((resolve) => {
      const check = () => {
        if (this.closed) return resolve();
        if (this.drawFrame(0, true)) resolve();
        else setTimeout(check, 30);
      };
      check();
    });
  }

  onSheet() {
    if (this.pendingJump !== null) {
      const index = Math.round(this.pendingJump * this.fps);
      if (this.drawFrame(index)) {
        this.time = this.pendingJump;
        this.pendingJump = null;
      }
    }
  }

  drawPoster() {
    if (!this.poster?.complete || !this.poster.naturalWidth) return;
    this.drawImage(
      this.poster,
      0,
      0,
      this.poster.naturalWidth,
      this.poster.naturalHeight,
    );
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);

    if (this.lastCanvasW && this.lastCanvasH) {
      const dw = Math.abs(this.lastCanvasW - w);
      const dh = Math.abs(this.lastCanvasH - h);
      if (dw < 4 && dh < 60) {
        return; // Ignore mobile address bar shifts
      }
    }

    this.lastCanvasW = w;
    this.lastCanvasH = h;
    this.width = w;
    this.height = h;

    const nativeDpr = window.devicePixelRatio || 1;
    const dpr = IS_MOBILE ? Math.min(nativeDpr, 1.5) : Math.min(Math.max(nativeDpr, 1.25), 2.0);
    const targetW = Math.round(this.width * dpr);
    const targetH = Math.round(this.height * dpr);

    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }

    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.scale(dpr, dpr);
    this.drawWidth = this.width;
    this.drawHeight = this.height;
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = "medium";
    if (this.frame >= 0 && this.store) this.drawFrame(this.frame, true);
    else this.drawPoster();
  }

  drawImage(image, sx, sy, width, height) {
    const scale = Math.max(this.drawWidth / width, this.drawHeight / height);
    const dw = width * scale;
    const dh = height * scale;
    const dx = (this.drawWidth - dw) / 2;
    const dy = (this.drawHeight - dh) / 2;
    this.context.drawImage(
      image,
      sx,
      sy,
      width,
      height,
      Math.round(dx),
      Math.round(dy),
      Math.round(dw),
      Math.round(dh),
    );
  }

  drawFrame(index, force = false) {
    if (!force && index === this.frame) return true;
    const sheet = Math.floor(index / this.perSheet);
    let image = this.store.cache.get(sheet);
    if (!image) {
      image = this.store.getClosestCached(sheet);
      if (!image) return false;
    }

    const nw = image.naturalWidth || image.width;
    const nh = image.naturalHeight || image.height;
    if (nw && nh) {
      if (nw === 1920 && nh === 720) {
        this.info.width = 640;
        this.info.height = 360;
        this.columns = 3;
        this.perSheet = 6;
      } else if (nw === 3840 && nh === 1440) {
        this.info.width = 1280;
        this.info.height = 720;
        this.columns = 3;
        this.perSheet = 6;
      } else {
        const cols = Math.max(1, Math.round(nw / this.info.width));
        const rows = Math.max(1, Math.round(nh / this.info.height));
        this.columns = cols;
        this.perSheet = cols * rows;
      }
    }

    const cell = index % this.perSheet;
    this.drawImage(
      image,
      (cell % this.columns) * this.info.width,
      Math.floor(cell / this.columns) * this.info.height,
      this.info.width,
      this.info.height,
    );
    this.frame = index;
    this.currentTime = index / this.fps;
    // Keep dataset attributes updated for testing without thrashing layout
    if (index % 12 === 0 || index === 0) {
      this.canvas.dataset.frame = String(index);
      this.canvas.dataset.time = String(this.currentTime);
      this.canvas.dataset.cachedSheets = String(this.store.cache.size);
    }
    this.onFrame?.(this.currentTime);
    return true;
  }

  scrubTo(time) {
    if (!this.store || this.closed) return;
    const target = Math.max(0, Math.min(this.end, time));
    const index = Math.round(target * this.fps);
    const sheet = Math.floor(index / this.perSheet);
    const dir = index >= this.frame ? 1 : -1;
    this.store.focus(sheet, dir);
    if (this.drawFrame(index)) {
      this.time = target;
      this.pendingJump = null;
    } else {
      this.pendingJump = target;
    }
  }

  seek(time) {
    if (!this.store) return;
    this.pendingJump = Math.max(0, Math.min(this.end, time));
    const index = Math.round(this.pendingJump * this.fps);
    this.store.focus(Math.floor(index / this.perSheet));
    this.onSheet();
  }

  fail(error) {
    if (this.closed) return;
    this.onError?.(error);
  }

  dispose() {
    this.closed = true;
    this.store?.dispose();
  }
}
