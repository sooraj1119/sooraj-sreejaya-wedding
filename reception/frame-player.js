const STATIC_MANIFEST = {
  fps: 24,
  columns: 3,
  rows: 2,
  variants: {
    mobile: { width: 640, height: 360, count: 480, sheets: 80 },
    desktop: { width: 1280, height: 720, count: 480, sheets: 80 }
  }
};

const PREFETCH_FRAMES = 72; // 12 sheets (~3.0s lookahead buffer)

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
  }

  sheetUrl(index) {
    return `${this.framesBase}/${this.variant}/${String(index).padStart(3, "0")}.webp?v=8.2`;
  }

  bootstrap() {
    this.bootstrapEnd = this.prefetchSheets;
    this.pump();
  }

  clearBootstrap(atSheet) {
    if (atSheet >= this.bootstrapEnd - 1) this.bootstrapEnd = 0;
  }

  keepInCache(index) {
    return this.wanted.includes(index) || index < this.bootstrapEnd;
  }

  focus(sheet, direction = 1) {
    const dir = direction || 1;
    const wanted = [];
    // Keep 2 sheets behind for smooth backward scrubbing
    for (let b = 2; b >= 1; b--) {
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
    if (wanted.join() === this.wanted.join()) return;
    this.wanted = wanted;

    for (const [index, bitmap] of this.cache) {
      if (!this.keepInCache(index)) {
        if (bitmap && typeof bitmap.close === "function") bitmap.close();
        this.cache.delete(index);
      }
    }
    for (const [index, request] of this.loading) {
      if (!this.keepInCache(index)) request.abort();
    }
    this.pump();
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
        image.close = () => {
          image.src = "";
        };
        bitmap = image;
      }
      if (
        this.closed ||
        controller.signal.aborted ||
        !this.keepInCache(index)
      ) {
        if (bitmap && typeof bitmap.close === "function") bitmap.close();
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

  dispose() {
    this.closed = true;
    for (const request of this.loading.values()) request.abort();
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

  async warmHalf(onProgress) {
    const total = Math.max(1, Math.ceil(this.info.sheets * 0.25));
    let done = 0;
    let next = 0;
    const concurrency = 4;
    const run = async () => {
      while (next < total && !this.closed) {
        const index = next++;
        try {
          const response = await fetch(this.store.sheetUrl(index));
          if (!response.ok) throw new Error(`Warm ${response.status}`);
          await response.blob();
        } catch {}
        done += 1;
        onProgress?.(done / total);
      }
    };
    await Promise.all(
      Array.from({ length: concurrency }, () => run()),
    );
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

      // Immediate streaming startup matching hindu-wedding-invite
      this.onProgress?.(0.5, "Preparing your journey...");
      this.pendingJump = 0;
      this.store.focus(0);
      this.store.bootstrap();

      // Background stream remaining sheets into HTTP cache
      this.warmHalf(() => {}).catch(() => {});
    } catch (error) {
      this.fail(error);
    }
  }

  onSheet() {
    if (this.pendingJump !== null) {
      const index = Math.round(this.pendingJump * this.fps);
      if (this.drawFrame(index)) {
        this.time = this.pendingJump;
        this.pendingJump = null;
        if (!this.ready) {
          this.ready = true;
          this.onProgress?.(1, "");
          this.onReady?.({ duration: this.duration, fps: this.fps });
        }
        this.onFrame?.(this.time);
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
        return;
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
    const sheet = Math.floor(index / this.perSheet);
    const bitmap = this.store?.cache.get(sheet);
    if (!bitmap) return false;

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
    if (this.status) this.status.textContent = "";
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

  fail(error) {
    if (this.closed) return;
    this.dispose();
    this.onError?.(error);
  }

  dispose() {
    this.closed = true;
    this.store?.dispose();
  }
}
