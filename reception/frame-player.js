const STATIC_MANIFEST = {
  fps: 24,
  columns: 3,
  rows: 2,
  variants: {
    mobile: { width: 640, height: 360, count: 480, sheets: 80 },
    desktop: { width: 1280, height: 720, count: 480, sheets: 80 }
  }
};

const INITIAL_WARM_SHEETS = 8; // 48 frames (2.0s of continuous runway buffer)
const PREFETCH_FRAMES = 72; // 12 sheets ahead (3.0s lookahead buffer)
const MAX_CACHE_SHEETS = 48; // Generous RAM buffer (under 25MB total RAM on mobile)
const MAX_CONCURRENT = 6;

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
    this.loading = new Set();
    this.failures = new Map();
    this.wanted = [];
    this.bootstrapEnd = INITIAL_WARM_SHEETS;
    this.onLoad = onLoad;
    this.onError = onError;
    this.closed = false;
  }

  sheetUrl(index) {
    return `${this.framesBase}/${this.variant}/${String(index).padStart(3, "0")}.webp?v=8.4`;
  }

  async fetchAndDecode(index) {
    if (this.cache.has(index)) return this.cache.get(index);
    const response = await fetch(this.sheetUrl(index));
    if (!response.ok) throw new Error(`Sheet ${index} status ${response.status}`);
    const blob = await response.blob();
    let bitmap;
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
    if (!this.closed) {
      this.cache.set(index, bitmap);
      this.onLoad();
    }
    return bitmap;
  }

  focus(sheet, direction = 1) {
    const dir = direction || 1;
    const wanted = [];
    // Keep 3 sheets behind for smooth backward scrubbing
    for (let b = 3; b >= 1; b--) {
      const behind = sheet - b * dir;
      if (behind >= 0 && behind < this.info.sheets) wanted.push(behind);
    }
    // Target sheet
    if (sheet >= 0 && sheet < this.info.sheets && !wanted.includes(sheet)) {
      wanted.push(sheet);
    }
    // Forward lookahead
    for (let i = 1; i <= this.prefetchSheets; i++) {
      const idx = sheet + i * dir;
      if (idx >= 0 && idx < this.info.sheets && !wanted.includes(idx)) {
        wanted.push(idx);
      }
    }
    this.wanted = wanted;
    this.evictExcess();
    this.pump();
  }

  evictExcess() {
    if (this.cache.size <= MAX_CACHE_SHEETS) return;
    for (const [index, bitmap] of this.cache) {
      // Never evict the initial bootstrap runway or current wanted window
      if (index >= this.bootstrapEnd && !this.wanted.includes(index)) {
        if (bitmap && typeof bitmap.close === "function") bitmap.close();
        this.cache.delete(index);
        if (this.cache.size <= MAX_CACHE_SHEETS) break;
      }
    }
  }

  pump() {
    if (this.closed) return;
    for (const index of this.wanted) {
      if (this.loading.size >= MAX_CONCURRENT) break;
      if (this.cache.has(index) || this.loading.has(index) || (this.failures.get(index) || 0) >= 3) {
        continue;
      }
      this.loading.add(index);
      this.fetchAndDecode(index)
        .catch((err) => {
          const count = (this.failures.get(index) || 0) + 1;
          this.failures.set(index, count);
        })
        .finally(() => {
          this.loading.delete(index);
          this.pump();
        });
    }
  }

  getBestAvailableSheet(targetSheet) {
    if (this.cache.has(targetSheet)) return targetSheet;
    for (let s = targetSheet - 1; s >= 0; s--) {
      if (this.cache.has(s)) return s;
    }
    for (let s = targetSheet + 1; s < this.info.sheets; s++) {
      if (this.cache.has(s)) return s;
    }
    return -1;
  }

  dispose() {
    this.closed = true;
    for (const bitmap of this.cache.values()) {
      if (bitmap && typeof bitmap.close === "function") bitmap.close();
    }
    this.cache.clear();
  }
}

export class FramePlayer {
  constructor({
    canvas,
    status,
    framesBase = "./frames",
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
    this.coarse = typeof window !== "undefined" && (matchMedia("(pointer: coarse)").matches || innerWidth < 900);
    this.rate = this.coarse ? 2.5 : 2.2;
    this.boost = 1;
    this.frame = -1;
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

  async load() {
    try {
      this.fps = STATIC_MANIFEST.fps;
      this.perSheet = STATIC_MANIFEST.columns * STATIC_MANIFEST.rows;
      this.columns = STATIC_MANIFEST.columns;
      const coarse = typeof window !== "undefined" && (matchMedia("(pointer: coarse)").matches || innerWidth < 900);
      this.variant = (typeof window !== "undefined" && innerWidth <= 768) ? "mobile" : "desktop";
      this.coarse = coarse;
      this.rate = coarse ? 2.5 : 2.2;
      this.info = STATIC_MANIFEST.variants[this.variant] || STATIC_MANIFEST.variants["desktop"];
      this.duration = this.info.count / this.fps;
      this.end = (this.info.count - 1) / this.fps;
      this.store = new FrameSheets(
        STATIC_MANIFEST,
        this.variant,
        this.framesBase,
        () => this.onSheet(),
        (error) => this.fail(error),
      );
      this.resize();

      // Golden Runway Buffer: pre-decode the first 8 sheets (~2.0s) so scroll NEVER gets stuck
      const warmCount = Math.min(this.info.sheets, INITIAL_WARM_SHEETS);
      let warmed = 0;
      this.onProgress?.(0.1, "Preparing your journey...");

      const warmPromises = Array.from({ length: warmCount }, async (_, i) => {
        try {
          await this.store.fetchAndDecode(i);
        } catch {}
        warmed += 1;
        this.onProgress?.(0.1 + (warmed / warmCount) * 0.9, "Preparing your journey...");
      });
      await Promise.all(warmPromises);

      // Draw initial frame 0 immediately
      this.drawFrame(0, true);
      this.ready = true;
      this.onProgress?.(1, "");
      this.onReady?.({ duration: this.duration, fps: this.fps });

      // Start continuous background streamer for the remaining sheets
      this.startContinuousStream();
    } catch (error) {
      this.fail(error);
    }
  }

  async startContinuousStream() {
    // Continuously download the remaining sheets into HTTP cache and RAM in background
    let next = INITIAL_WARM_SHEETS;
    const total = this.info.sheets;
    const concurrency = 3;
    const worker = async () => {
      while (next < total && !this.closed) {
        const idx = next++;
        try {
          await this.store.fetchAndDecode(idx);
        } catch {}
      }
    };
    for (let c = 0; c < concurrency; c++) {
      worker();
    }
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
        return; // ignore mobile address bar shifts
      }
    }

    this.lastCanvasW = w;
    this.lastCanvasH = h;
    this.width = w;
    this.height = h;

    const nativeDpr = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1;
    const isMobile = typeof window !== "undefined" && window.innerWidth <= 768;
    const dpr = isMobile ? Math.min(nativeDpr, 1.5) : Math.min(Math.max(nativeDpr, 1.25), 2.0);
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
    const targetSheet = Math.floor(index / this.perSheet);
    
    let sheetToDraw = targetSheet;
    let bitmap = this.store?.cache.get(sheetToDraw);
    let cell = index % this.perSheet;

    if (!bitmap) {
      const fallbackSheet = this.store?.getBestAvailableSheet(targetSheet);
      if (fallbackSheet === -1) return false;
      sheetToDraw = fallbackSheet;
      bitmap = this.store.cache.get(sheetToDraw);
      if (targetSheet > fallbackSheet) {
        cell = this.perSheet - 1;
      } else {
        cell = 0;
      }
    }

    if (!bitmap) return false;

    this.drawImage(
      bitmap,
      (cell % this.columns) * this.info.width,
      Math.floor(cell / this.columns) * this.info.height,
      this.info.width,
      this.info.height,
    );

    const actualDrawnFrame = sheetToDraw * this.perSheet + cell;
    this.frame = actualDrawnFrame;
    this.canvas.dataset.frame = String(actualDrawnFrame);
    this.canvas.dataset.time = String(actualDrawnFrame / this.fps);
    this.canvas.dataset.cachedSheets = String(this.store.cache.size);
    if (this.status) this.status.textContent = "";
    this.onFrame?.(actualDrawnFrame / this.fps);

    return (sheetToDraw === targetSheet);
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

  fail(error) {
    if (this.closed) return;
    this.dispose();
    this.onError?.(error);
  }

  getBestAvailableSheet(targetSheet) {
    if (this.cache.has(targetSheet)) return targetSheet;
    for (let s = targetSheet - 1; s >= 0; s--) {
      if (this.cache.has(s)) return s;
    }
    for (let s = targetSheet + 1; s < this.info.sheets; s++) {
      if (this.cache.has(s)) return s;
    }
    return -1;
  }

  dispose() {
    this.closed = true;
    this.store?.dispose();
  }
}
