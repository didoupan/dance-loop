import { clamp, formatTime } from './utils';

type DragTarget = 'a' | 'b' | 'scrub' | null;

const MIN_GAP = 0.08;

/**
 * 时间轴：缩略图、播放头、A/B 手柄、拖动预览。
 */
export class Timeline {
  private readonly root: HTMLElement;
  private readonly thumbs: HTMLElement;
  private readonly loopEl: HTMLElement;
  private readonly shadeLeft: HTMLElement;
  private readonly shadeRight: HTMLElement;
  private readonly playhead: HTMLElement;
  private readonly handleA: HTMLElement;
  private readonly handleB: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly durationLabel: HTMLElement;

  duration = 0;
  a = 0;
  b = 0;
  time = 0;
  enabled = true;

  onSeek: (time: number) => void = () => {};
  onScrubStart: () => void = () => {};
  onScrubEnd: () => void = () => {};
  onLoopChange: (a: number, b: number) => void = () => {};

  private drag: DragTarget = null;
  private pointerId: number | null = null;
  private pendingTime = 0;
  private seekRaf = 0;
  private pendingLoop = { a: 0, b: 0 };
  private loopRaf = 0;
  private thumbCount = 0;

  constructor(
    root: HTMLElement,
    thumbs: HTMLElement,
    loopEl: HTMLElement,
    shadeLeft: HTMLElement,
    shadeRight: HTMLElement,
    playhead: HTMLElement,
    handleA: HTMLElement,
    handleB: HTMLElement,
    tip: HTMLElement,
    durationLabel: HTMLElement,
  ) {
    this.root = root;
    this.thumbs = thumbs;
    this.loopEl = loopEl;
    this.shadeLeft = shadeLeft;
    this.shadeRight = shadeRight;
    this.playhead = playhead;
    this.handleA = handleA;
    this.handleB = handleB;
    this.tip = tip;
    this.durationLabel = durationLabel;

    root.addEventListener('pointerdown', this.handlePointerDown);
    root.addEventListener('pointermove', this.handlePointerMove);
    root.addEventListener('pointerup', this.handlePointerUp);
    root.addEventListener('pointercancel', this.handlePointerCancel);
    root.addEventListener('pointerleave', this.handlePointerLeave);
  }

  reset(): void {
    this.duration = 0;
    this.a = 0;
    this.b = 0;
    this.time = 0;
    this.thumbCount = 0;
    this.thumbs.innerHTML = '<div class="tl-thumbs-skeleton"></div>';
    this.root.classList.add('is-empty');
    this.root.classList.remove('is-loop-off');
    this.durationLabel.textContent = '0:00';
    this.update();
  }

  setDuration(duration: number): void {
    this.duration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
    this.root.classList.toggle('is-empty', this.duration <= 0);
    this.durationLabel.textContent = formatTime(this.duration, 0);
    this.root.setAttribute('aria-valuemax', String(this.duration));
    this.update();
  }

  setLoop(a: number, b: number, enabled: boolean): void {
    this.a = clamp(a, 0, this.duration);
    this.b = clamp(b, 0, this.duration);
    if (this.b < this.a) [this.a, this.b] = [this.b, this.a];
    this.enabled = enabled;
    this.root.classList.toggle('is-loop-off', !enabled);
    this.update();
  }

  setTime(time: number): void {
    if (!Number.isFinite(time)) return;
    this.time = clamp(time, 0, this.duration);
    const pct = this.percent(this.time);
    this.playhead.style.left = `${pct}%`;
    this.root.setAttribute('aria-valuenow', String(this.time));
    this.root.setAttribute('aria-valuetext', formatTime(this.time));
  }

  clearThumbnails(): void {
    this.thumbCount = 0;
    this.thumbs.innerHTML = '<div class="tl-thumbs-skeleton"></div>';
  }

  setThumbnails(count: number): void {
    if (!count) return;
    this.thumbCount = count;
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i += 1) {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      img.style.opacity = '0';
      fragment.append(img);
    }
    this.thumbs.replaceChildren(fragment);
  }

  finishThumbnails(): void {
    this.thumbs.querySelector('.tl-thumbs-skeleton')?.remove();
  }

  setThumbnail(index: number, url: string, count: number): void {
    if (this.thumbCount !== count) this.setThumbnails(count);
    const img = this.thumbs.children[index];
    if (img instanceof HTMLImageElement) {
      img.addEventListener(
        'load',
        () => {
          img.style.opacity = '';
        },
        { once: true },
      );
      img.src = url;
    }
  }

  private percent(value: number): number {
    if (this.duration <= 0) return 0;
    return clamp((value / this.duration) * 100, 0, 100);
  }

  private update(): void {
    const aPct = this.percent(this.a);
    const bPct = this.percent(this.b);
    const width = Math.max(0, bPct - aPct);
    const rightWidth = Math.max(0, 100 - bPct);

    this.loopEl.style.left = `${aPct}%`;
    this.loopEl.style.width = `${width}%`;
    this.shadeLeft.style.width = `${aPct}%`;
    this.shadeRight.style.left = `${bPct}%`;
    this.shadeRight.style.width = `${rightWidth}%`;

    this.handleA.style.left = `${aPct}%`;
    this.handleB.style.left = `${bPct}%`;

    this.setTime(this.time);
  }

  private timeFromEvent(event: PointerEvent): number {
    const rect = this.root.getBoundingClientRect();
    if (!rect.width) return 0;
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    return ratio * this.duration;
  }

  private showTip(time: number, clientX?: number): void {
    if (!this.duration) return;
    const rect = this.root.getBoundingClientRect();
    let x: number;
    if (typeof clientX === 'number') {
      x = clamp(clientX - rect.left, 8, rect.width - 8);
    } else {
      x = (this.percent(time) / 100) * rect.width;
      x = clamp(x, 8, rect.width - 8);
    }
    this.tip.textContent = formatTime(time, 3);
    this.tip.style.left = `${x}px`;
    this.tip.classList.add('is-visible');
  }

  private hideTip(): void {
    this.tip.classList.remove('is-visible');
  }

  private queueSeek(time: number): void {
    this.pendingTime = time;
    this.setTime(time);
    if (!this.seekRaf) {
      this.seekRaf = requestAnimationFrame(() => {
        this.seekRaf = 0;
        this.onSeek(this.pendingTime);
      });
    }
  }

  private flushSeek(): void {
    if (this.seekRaf) {
      cancelAnimationFrame(this.seekRaf);
      this.seekRaf = 0;
    }
    this.onSeek(this.pendingTime);
  }

  private queueLoop(a: number, b: number): void {
    this.pendingLoop = { a, b };
    if (!this.loopRaf) {
      this.loopRaf = requestAnimationFrame(() => {
        this.loopRaf = 0;
        this.onLoopChange(this.pendingLoop.a, this.pendingLoop.b);
      });
    }
  }

  private flushLoop(): void {
    if (this.loopRaf) {
      cancelAnimationFrame(this.loopRaf);
      this.loopRaf = 0;
    }
    this.onLoopChange(this.pendingLoop.a, this.pendingLoop.b);
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (!this.duration) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    const handle = target?.closest<HTMLElement>('[data-handle]');
    this.pointerId = event.pointerId;
    try {
      this.root.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }

    if (handle) {
      this.drag = handle.dataset.handle === 'a' ? 'a' : 'b';
      this.updateHandleFromEvent(event);
      event.preventDefault();
      return;
    }

    this.drag = 'scrub';
    this.onScrubStart();
    const time = this.timeFromEvent(event);
    this.pendingTime = time;
    this.setTime(time);
    this.showTip(time, event.clientX);
    event.preventDefault();
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.duration) return;

    if (this.drag === 'a' || this.drag === 'b') {
      if (event.pointerId !== this.pointerId) return;
      this.updateHandleFromEvent(event);
      event.preventDefault();
      return;
    }

    const time = this.timeFromEvent(event);
    this.showTip(time, event.clientX);

    if (this.drag === 'scrub' && event.pointerId === this.pointerId) {
      this.queueSeek(time);
      event.preventDefault();
    }
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;

    if (this.drag === 'a' || this.drag === 'b') {
      this.flushLoop();
    } else if (this.drag === 'scrub') {
      this.flushSeek();
      this.onScrubEnd();
    }

    this.drag = null;
    this.pointerId = null;
    this.hideTip();
    this.releasePointer(event.pointerId);
  };

  private handlePointerCancel = (event: PointerEvent): void => {
    if (this.pointerId === null || event.pointerId !== this.pointerId) return;

    if (this.drag === 'a' || this.drag === 'b') {
      this.flushLoop();
    } else if (this.drag === 'scrub') {
      this.flushSeek();
      this.onScrubEnd();
    }

    this.drag = null;
    this.pointerId = null;
    this.hideTip();
    this.releasePointer(event.pointerId);
  };

  private handlePointerLeave = (): void => {
    if (!this.drag) this.hideTip();
  };

  private updateHandleFromEvent(event: PointerEvent): void {
    const time = this.timeFromEvent(event);

    if (this.drag === 'a') {
      const nextA = clamp(time, 0, Math.max(0, this.b - MIN_GAP));
      this.a = nextA;
      this.update();
      this.queueLoop(this.a, this.b);
      this.showTip(this.a, event.clientX);
    } else if (this.drag === 'b') {
      const nextB = clamp(time, Math.min(this.duration, this.a + MIN_GAP), this.duration);
      this.b = nextB;
      this.update();
      this.queueLoop(this.a, this.b);
      this.showTip(this.b, event.clientX);
    }
  }

  private releasePointer(pointerId: number): void {
    try {
      if (this.root.hasPointerCapture(pointerId)) {
        this.root.releasePointerCapture(pointerId);
      }
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    this.root.removeEventListener('pointerdown', this.handlePointerDown);
    this.root.removeEventListener('pointermove', this.handlePointerMove);
    this.root.removeEventListener('pointerup', this.handlePointerUp);
    this.root.removeEventListener('pointercancel', this.handlePointerCancel);
    this.root.removeEventListener('pointerleave', this.handlePointerLeave);
    if (this.seekRaf) cancelAnimationFrame(this.seekRaf);
    if (this.loopRaf) cancelAnimationFrame(this.loopRaf);
  }
}
