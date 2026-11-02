// High-Performance Zero-Lag Frame Player with LRU Cache & Background Prewarm
const PREFETCH_FRAMES = 96; // ~16 sheets ahead
const INITIAL_WARM_SHEETS = 12; // first 12 sheets (~72 frames) loaded before onReady
const MAX_CACHE_SHEETS = 50; // Keep up to 50 decoded sheets in memory (~300 frames)

class FrameSheets {
  constructor(manifest, variant, framesBase, onLoad, onError) {
    this.framesBase = framesBase;
    this.manifest = manifest;
    this.variant = variant;
    this.info = manifest.variants[variant];
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
    return `${this.framesBase}/${this.variant}/${String(index).padStart(3, "0")}.webp?v=5.2`;
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
    const behind = sheet - dir;
    if (behind >= 0 && behind < this.info.sheets) wanted.push(behind);
    for (let i = 0; i <= this.prefetchSheets; i++) {
      const idx = sheet + i * dir;
      if (idx >= 0 && idx < this.info.sheets) wanted.push(idx);
    }
    this.wanted = wanted;
    this.evictExcess();
    this.pump();
  }

  evictExcess() {
    if (this.cache.size <= MAX_CACHE_SHEETS) return;
    for (const [index, bitmap] of this.cache) {
      if (!this.wanted.includes(index) && index >= this.bootstrapEnd) {
        try { if (bitmap && typeof bitmap.close === "function") bitmap.close(); } catch {}
        this.cache.delete(index);
        if (this.cache.size <= MAX_CACHE_SHEETS) break;
      }
    }
  }

  getClosestCached(targetSheet) {
    if (this.cache.has(targetSheet)) return this.cache.get(targetSheet);
    let best = null;
    let minDiff = Infinity;
    for (const [sheetIdx, bitmap] of this.cache) {
      const diff = Math.abs(sheetIdx - targetSheet);
      if (diff < minDiff && diff <= 4) {
        minDiff = diff;
        best = bitmap;
      }
    }
    return best;
  }

  maxConcurrent() {
    return 8;
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
    let bitmap;
    try {
      const response = await fetch(this.sheetUrl(index), {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Frame sheet ${response.status}`);
      const blob = await response.blob();
      if ("createImageBitmap" in window) {
        bitmap = await createImageBitmap(blob);
      } else {
        const url = URL.createObjectURL(blob);
        const image = new Image();
        image.src = url;
        try {
          await image.decode();
        } finally {
          URL.revokeObjectURL(url);
        }
        image.close = () => { image.src = ""; };
        bitmap = image;
      }
      if (this.closed || controller.signal.aborted) {
        try { if (bitmap && typeof bitmap.close === "function") bitmap.close(); } catch {}
      } else {
        this.cache.set(index, bitmap);
        this.onLoad();
      }
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

  // Progressive background prewarm of all sheets into browser HTTP cache
  startBackgroundWarm() {
    if (this.backgroundWarming || this.closed) return;
    this.backgroundWarming = true;
    const total = this.info.sheets;
    let next = INITIAL_WARM_SHEETS;
    const concurrency = 4;
    const runWorker = async () => {
      while (next < total && !this.closed) {
        const idx = next++;
        try {
          const resp = await fetch(this.sheetUrl(idx));
          if (resp.ok) await resp.blob();
        } catch {}
        // Yield to main thread
        await new Promise(r => setTimeout(r, 40));
      }
    };
    for (let c = 0; c < concurrency; c++) {
      runWorker();
    }
  }

  dispose() {
    this.closed = true;
    for (const request of this.loading.values()) request.abort();
    for (const bitmap of this.cache.values()) {
      try { if (bitmap && typeof bitmap.close === "function") bitmap.close(); } catch {}
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
      while (next < total && !this.closed) {
        const index = next++;
        try {
          const response = await fetch(this.store.sheetUrl(index));
          if (response.ok) await response.blob();
        } catch {}
        done += 1;
        onProgress?.(done / total);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(6, total) }, () => run())
    );
  }

  async load() {
    try {
      this.onProgress?.(0.1, "Preparing your journey...");
      const response = await fetch(`${this.framesBase}/manifest.json?v=5.2`, { cache: "no-store" });
      if (!response.ok) throw new Error("Frame manifest unavailable");
      const manifest = await response.json();
      if (this.closed) return;
      this.fps = manifest.fps;
      this.perSheet = manifest.columns * manifest.rows;
      this.columns = manifest.columns;
      this.variant = "desktop"; // 1280x720 HD frames across all devices
      this.info = manifest.variants[this.variant];
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
      
      // Immediately kick off background caching of remaining sheets
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
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    const nativeDpr = window.devicePixelRatio || 1;
    // Support up to 3x Retina DPR for crisp display
    const dpr = Math.min(Math.max(nativeDpr, 1.5), 3);
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.scale(dpr, dpr);
    this.drawWidth = this.width;
    this.drawHeight = this.height;
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = "high";
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
    let bitmap = this.store.cache.get(sheet);
    if (!bitmap) {
      bitmap = this.store.getClosestCached(sheet);
      if (!bitmap) return false;
    }

    // Defensive grid geometry calculation
    if (bitmap.width && bitmap.height) {
      if (bitmap.width === 3840 && bitmap.height === 1440) {
        this.info.width = 1280;
        this.info.height = 720;
        this.columns = 3;
        this.perSheet = 6;
      } else {
        const cols = Math.max(1, Math.round(bitmap.width / this.info.width));
        const rows = Math.max(1, Math.round(bitmap.height / this.info.height));
        this.columns = cols;
        this.perSheet = cols * rows;
      }
    }

    const cell = index % this.perSheet;
    this.drawImage(
      bitmap,
      (cell % this.columns) * this.info.width,
      Math.floor(cell / this.columns) * this.info.height,
      this.info.width,
      this.info.height,
    );
    this.frame = index;
    this.canvas.dataset.frame = String(index);
    this.canvas.dataset.time = String(index / this.fps);
    this.canvas.dataset.cachedSheets = String(this.store.cache.size);
    this.onFrame?.(index / this.fps);
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
