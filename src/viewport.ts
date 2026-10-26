import { clamp, type SizeMode } from './utils';

interface Point {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MAX_SCALE = 8;
const MIN_SCALE = 1;

/**
 * 舞台视图：负责视频在舞台中的尺寸、缩放、平移、双指捏合与框选放大。
 */
export class StageView {
  private readonly stage: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly captureLayer: HTMLElement;
  private readonly captureRect: HTMLElement;

  private mode: SizeMode = 'fit';
  private percent = 100;
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private baseW = 0;
  private baseH = 0;
  private stageW = 0;
  private stageH = 0;
  private ready = false;

  regionMode = false;

  onTransform: (scale: number) => void = () => {};
  onTap: () => void = () => {};
  onRegionModeChange: (active: boolean) => void = () => {};

  private pointers = new Map<number, Point>();
  private gesture: 'none' | 'pan' | 'pinch' = 'none';
  private gestureMoved = false;
  private panOrigin = { x: 0, y: 0, tx: 0, ty: 0 };
  private pinchOrigin = {
    dist: 0,
    mid: { x: 0, y: 0 },
    scale: 1,
    tx: 0,
    ty: 0,
  };
  private downAt = 0;

  private regionPointerId: number | null = null;
  private regionStart: Point | null = null;
  private regionCurrent: Point | null = null;

  private animationTimer = 0;
  private resizeRaf = 0;
  private resizeObserver: ResizeObserver;

  constructor(
    stage: HTMLElement,
    viewport: HTMLElement,
    video: HTMLVideoElement,
    captureLayer: HTMLElement,
    captureRect: HTMLElement,
  ) {
    this.stage = stage;
    this.viewport = viewport;
    this.video = video;
    this.captureLayer = captureLayer;
    this.captureRect = captureRect;

    stage.addEventListener('pointerdown', this.handlePointerDown);
    stage.addEventListener('pointermove', this.handlePointerMove);
    stage.addEventListener('pointerup', this.handlePointerUp);
    stage.addEventListener('pointercancel', this.handlePointerCancel);
    stage.addEventListener('wheel', this.handleWheel, { passive: false });

    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(stage);
  }

  get scaleValue(): number {
    return this.scale;
  }

  get isReady(): boolean {
    return this.ready;
  }

  setReady(ready: boolean): void {
    this.ready = ready;
    if (!ready) {
      this.viewport.style.display = 'none';
      this.exitRegionMode();
      return;
    }
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.viewport.style.display = 'block';
    this.layout(false);
  }

  setMode(mode: SizeMode, percent = this.percent): void {
    this.mode = mode;
    this.percent = clamp(percent, 25, 150);
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.layout(true);
  }

  setPercent(percent: number): void {
    this.percent = clamp(percent, 25, 150);
    if (this.mode === 'custom') {
      this.scale = 1;
      this.tx = 0;
      this.ty = 0;
      this.layout(false);
    }
  }

  setMirror(mirror: boolean): void {
    this.video.classList.toggle('is-mirrored', mirror);
  }

  refresh(): void {
    this.layout(false);
  }

  setZoom(scale: number, animate = false): void {
    const next = clamp(scale, MIN_SCALE, MAX_SCALE);
    if (Math.abs(next - this.scale) < 0.0001) return;
    const factor = next / this.scale;
    this.zoomAt(factor, { x: this.stageW / 2, y: this.stageH / 2 }, animate);
  }

  resetZoom(animate = true): void {
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.clampPan();
    this.apply(animate);
  }

  toggleRegionMode(): void {
    if (this.regionMode) {
      this.exitRegionMode();
    } else {
      this.enableRegionMode();
    }
  }

  enableRegionMode(): boolean {
    if (!this.ready) return false;
    this.regionMode = true;
    this.regionStart = null;
    this.regionCurrent = null;
    this.regionPointerId = null;
    this.stage.classList.add('is-region-mode');
    this.captureLayer.hidden = false;
    this.hideCaptureRect();
    this.onRegionModeChange(true);
    return true;
  }

  exitRegionMode(): void {
    if (!this.regionMode) return;
    this.regionMode = false;
    this.regionPointerId = null;
    this.regionStart = null;
    this.regionCurrent = null;
    this.stage.classList.remove('is-region-mode');
    this.captureLayer.hidden = true;
    this.hideCaptureRect();
    this.onRegionModeChange(false);
  }

  private layout(animate: boolean): void {
    if (!this.ready || !this.video.videoWidth || !this.video.videoHeight) {
      this.viewport.style.display = 'none';
      return;
    }

    const width = this.stage.clientWidth;
    const height = this.stage.clientHeight;
    if (width <= 0 || height <= 0) return;

    const prevW = this.baseW;
    const prevH = this.baseH;
    const prevCenterX = prevW > 0 ? (this.stageW / 2 - this.tx) / (prevW * this.scale) : 0.5;
    const prevCenterY = prevH > 0 ? (this.stageH / 2 - this.ty) / (prevH * this.scale) : 0.5;

    this.stageW = width;
    this.stageH = height;

    const aspect = this.video.videoWidth / this.video.videoHeight;
    const fitW = Math.min(width, height * aspect);
    const fitH = fitW / aspect;

    let nextW = fitW;
    let nextH = fitH;
    let objectFit: 'fill' | 'cover' = 'fill';

    if (this.mode === 'fill') {
      nextW = width;
      nextH = height;
      objectFit = 'cover';
    } else if (this.mode === 'custom') {
      nextW = fitW * (this.percent / 100);
      nextH = fitH * (this.percent / 100);
    }

    this.baseW = Math.max(1, nextW);
    this.baseH = Math.max(1, nextH);

    this.viewport.style.width = `${this.baseW}px`;
    this.viewport.style.height = `${this.baseH}px`;
    this.video.style.objectFit = objectFit;
    this.viewport.style.display = 'block';

    if (prevW > 0 && prevH > 0) {
      // 舞台尺寸变化时，保持画面中心的相对位置。
      this.tx = this.stageW / 2 - prevCenterX * this.baseW * this.scale;
      this.ty = this.stageH / 2 - prevCenterY * this.baseH * this.scale;
    } else {
      this.tx = (this.stageW - this.baseW * this.scale) / 2;
      this.ty = (this.stageH - this.baseH * this.scale) / 2;
    }

    this.clampPan();
    this.apply(animate);
  }

  private apply(animate: boolean): void {
    if (animate) {
      this.viewport.classList.add('is-animating');
      window.clearTimeout(this.animationTimer);
      this.animationTimer = window.setTimeout(() => {
        this.viewport.classList.remove('is-animating');
      }, 320);
    }
    this.viewport.style.transform = `translate3d(${this.tx}px, ${this.ty}px, 0) scale(${this.scale})`;
    this.onTransform(this.scale);
  }

  private clampPan(): void {
    const scaledW = this.baseW * this.scale;
    const scaledH = this.baseH * this.scale;

    if (scaledW <= this.stageW) {
      this.tx = (this.stageW - scaledW) / 2;
    } else {
      this.tx = clamp(this.tx, this.stageW - scaledW, 0);
    }

    if (scaledH <= this.stageH) {
      this.ty = (this.stageH - scaledH) / 2;
    } else {
      this.ty = clamp(this.ty, this.stageH - scaledH, 0);
    }
  }

  private zoomAt(factor: number, point: Point, animate = false): void {
    const nextScale = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    if (Math.abs(nextScale - this.scale) < 0.0001) return;

    const ratio = nextScale / this.scale;
    this.tx = point.x - (point.x - this.tx) * ratio;
    this.ty = point.y - (point.y - this.ty) * ratio;
    this.scale = nextScale;
    this.clampPan();
    this.apply(animate);
  }

  private localPoint(event: PointerEvent | WheelEvent): Point {
    const rect = this.stage.getBoundingClientRect();
    const left = rect.left + this.stage.clientLeft;
    const top = rect.top + this.stage.clientTop;
    return {
      x: clamp(event.clientX - left, 0, this.stageW || rect.width),
      y: clamp(event.clientY - top, 0, this.stageH || rect.height),
    };
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (!this.ready) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, input, label, a, .stage-loading, .stage-hud')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    try {
      this.stage.setPointerCapture(event.pointerId);
    } catch {
      /* 某些浏览器可能不支持 */
    }

    if (this.regionMode) {
      if (this.regionPointerId !== null) return;
      this.regionPointerId = event.pointerId;
      const point = this.localPoint(event);
      this.regionStart = point;
      this.regionCurrent = point;
      this.updateCaptureRect(point, point);
      event.preventDefault();
      return;
    }

    const point = this.localPoint(event);
    this.pointers.set(event.pointerId, point);

    if (this.pointers.size === 1) {
      this.gesture = 'pan';
      this.gestureMoved = false;
      this.downAt = performance.now();
      this.panOrigin = { x: point.x, y: point.y, tx: this.tx, ty: this.ty };
      this.stage.classList.add('is-dragging');
    } else if (this.pointers.size === 2) {
      this.gesture = 'pinch';
      this.gestureMoved = true;
      this.beginPinch();
    }

    event.preventDefault();
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.ready) return;

    if (this.regionMode) {
      if (event.pointerId !== this.regionPointerId || !this.regionStart) return;
      const point = this.localPoint(event);
      this.regionCurrent = point;
      this.updateCaptureRect(this.regionStart, point);
      event.preventDefault();
      return;
    }

    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, this.localPoint(event));

    if (this.gesture === 'pinch' && this.pointers.size >= 2) {
      this.updatePinch();
      event.preventDefault();
      return;
    }

    if (this.gesture === 'pan' && this.pointers.size === 1) {
      const point = this.pointers.values().next().value as Point;
      const dx = point.x - this.panOrigin.x;
      const dy = point.y - this.panOrigin.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) this.gestureMoved = true;
      this.tx = this.panOrigin.tx + dx;
      this.ty = this.panOrigin.ty + dy;
      this.clampPan();
      this.apply(false);
      event.preventDefault();
    }
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.ready) return;

    if (this.regionMode) {
      if (event.pointerId !== this.regionPointerId) return;
      this.finishCapture();
      this.releasePointer(event.pointerId);
      return;
    }

    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.delete(event.pointerId);
    this.releasePointer(event.pointerId);

    if (this.pointers.size === 1) {
      const point = this.pointers.values().next().value as Point;
      this.gesture = 'pan';
      this.gestureMoved = true;
      this.panOrigin = { x: point.x, y: point.y, tx: this.tx, ty: this.ty };
      return;
    }

    if (this.pointers.size === 0) {
      const wasMoved = this.gestureMoved;
      const elapsed = performance.now() - this.downAt;
      this.gesture = 'none';
      this.gestureMoved = false;
      this.stage.classList.remove('is-dragging');

      if (!wasMoved && elapsed < 600) {
        this.onTap();
      }
    }
  };

  private handlePointerCancel = (event: PointerEvent): void => {
    if (!this.ready) return;

    if (this.regionMode && event.pointerId === this.regionPointerId) {
      this.regionPointerId = null;
      this.regionStart = null;
      this.regionCurrent = null;
      this.hideCaptureRect();
      this.releasePointer(event.pointerId);
      return;
    }

    if (this.pointers.has(event.pointerId)) {
      this.pointers.delete(event.pointerId);
      this.releasePointer(event.pointerId);
      if (this.pointers.size === 0) {
        this.gesture = 'none';
        this.gestureMoved = false;
        this.stage.classList.remove('is-dragging');
      } else if (this.pointers.size === 1) {
        const point = this.pointers.values().next().value as Point;
        this.gesture = 'pan';
        this.gestureMoved = true;
        this.panOrigin = { x: point.x, y: point.y, tx: this.tx, ty: this.ty };
      }
    }
  };

  private handleWheel = (event: WheelEvent): void => {
    if (!this.ready) return;
    event.preventDefault();
    const point = this.localPoint(event);
    const delta = event.deltaMode === 1 ? event.deltaY * 0.05 : event.deltaY * 0.0015;
    const factor = Math.exp(-delta);
    this.zoomAt(factor, point);
  };

  private beginPinch(): void {
    const points = [...this.pointers.values()];
    if (points.length < 2) return;
    const [a, b] = points;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    this.pinchOrigin = {
      dist,
      mid,
      scale: this.scale,
      tx: this.tx,
      ty: this.ty,
    };
  }

  private updatePinch(): void {
    const points = [...this.pointers.values()];
    if (points.length < 2) return;
    const [a, b] = points;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const factor = dist / this.pinchOrigin.dist;
    const nextScale = clamp(this.pinchOrigin.scale * factor, MIN_SCALE, MAX_SCALE);

    const contentX = (this.pinchOrigin.mid.x - this.pinchOrigin.tx) / this.pinchOrigin.scale;
    const contentY = (this.pinchOrigin.mid.y - this.pinchOrigin.ty) / this.pinchOrigin.scale;

    this.scale = nextScale;
    this.tx = mid.x - contentX * nextScale;
    this.ty = mid.y - contentY * nextScale;
    this.clampPan();
    this.apply(false);
  }

  private updateCaptureRect(a: Point, b: Point): void {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x);
    const h = Math.abs(a.y - b.y);
    this.captureRect.style.display = w > 2 && h > 2 ? 'block' : 'none';
    this.captureRect.style.left = `${x}px`;
    this.captureRect.style.top = `${y}px`;
    this.captureRect.style.width = `${w}px`;
    this.captureRect.style.height = `${h}px`;
  }

  private hideCaptureRect(): void {
    this.captureRect.style.display = 'none';
  }

  private finishCapture(): void {
    const start = this.regionStart;
    const end = this.regionCurrent;
    this.regionPointerId = null;
    this.regionStart = null;
    this.regionCurrent = null;
    this.hideCaptureRect();

    if (!start || !end) {
      this.exitRegionMode();
      return;
    }

    const rect: Rect = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      w: Math.abs(start.x - end.x),
      h: Math.abs(start.y - end.y),
    };

    if (rect.w >= 24 && rect.h >= 24) {
      this.applyRegion(rect);
    }
    this.exitRegionMode();
  }

  private applyRegion(rect: Rect): void {
    if (!this.ready || this.scale <= 0) return;

    const contentX = (rect.x - this.tx) / this.scale;
    const contentY = (rect.y - this.ty) / this.scale;
    const contentW = rect.w / this.scale;
    const contentH = rect.h / this.scale;
    if (contentW <= 0 || contentH <= 0) return;

    const target = clamp(
      Math.min(this.stageW / contentW, this.stageH / contentH) * 0.94,
      MIN_SCALE,
      MAX_SCALE,
    );

    this.scale = target;
    this.tx = this.stageW / 2 - (contentX + contentW / 2) * target;
    this.ty = this.stageH / 2 - (contentY + contentH / 2) * target;
    this.clampPan();
    this.apply(true);
  }

  private releasePointer(pointerId: number): void {
    try {
      if (this.stage.hasPointerCapture(pointerId)) {
        this.stage.releasePointerCapture(pointerId);
      }
    } catch {
      /* ignore */
    }
  }

  private handleResize = (): void => {
    if (this.resizeRaf) return;
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = 0;
      this.layout(false);
    });
  };

  dispose(): void {
    this.resizeObserver.disconnect();
    this.stage.removeEventListener('pointerdown', this.handlePointerDown);
    this.stage.removeEventListener('pointermove', this.handlePointerMove);
    this.stage.removeEventListener('pointerup', this.handlePointerUp);
    this.stage.removeEventListener('pointercancel', this.handlePointerCancel);
    this.stage.removeEventListener('wheel', this.handleWheel);
    window.clearTimeout(this.animationTimer);
    if (this.resizeRaf) cancelAnimationFrame(this.resizeRaf);
  }
}
