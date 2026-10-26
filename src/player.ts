import { clamp } from './utils';

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
}

export interface LoopRange {
  a: number;
  b: number;
}

interface FrameApi {
  requestVideoFrameCallback(cb: (now: number, metadata: { mediaTime: number }) => void): number;
  cancelVideoFrameCallback(id: number): void;
}

/**
 * 视频播放核心：A-B 循环、变速、逐帧、音调保持、帧率估算。
 * 视图与界面通过回调订阅状态，不直接操作 video 元素。
 */
export class Player {
  readonly video: HTMLVideoElement;

  duration = 0;
  fps = 30;
  loop: LoopRange = { a: 0, b: 0 };
  loopEnabled = true;
  loopCount = 0;

  onTime: (time: number, duration: number) => void = () => {};
  onPlayChange: (playing: boolean) => void = () => {};
  onLoopCount: (count: number) => void = () => {};
  onFps: (fps: number) => void = () => {};
  onError: (message: string) => void = () => {};

  private speed = 1;
  private pitch = true;
  private objectUrl = '';
  private rafId = 0;
  private looping = false;
  private loopResetTimer = 0;

  private frameProbeId = 0;
  private frameSamples: number[] = [];
  private lastMediaTime: number | null = null;
  private fpsProbeDone = false;

  constructor(video: HTMLVideoElement) {
    this.video = video;
    video.addEventListener('play', this.handlePlay);
    video.addEventListener('pause', this.handlePause);
    video.addEventListener('seeked', this.handleSeeked);
    video.addEventListener('ended', this.handleEnded);
    video.addEventListener('error', this.handleError);
  }

  get playing(): boolean {
    return !this.video.paused && !this.video.ended;
  }

  get currentTime(): number {
    return this.video.currentTime;
  }

  get playbackSpeed(): number {
    return this.speed;
  }

  get sourceUrl(): string {
    return this.objectUrl;
  }

  async load(file: File): Promise<VideoInfo> {
    this.pause();
    this.stopTicking();
    this.stopFpsProbe();
    this.looping = false;
    this.duration = 0;
    this.loopCount = 0;
    this.fps = 30;
    this.fpsProbeDone = false;
    this.frameSamples = [];
    this.lastMediaTime = null;

    this.video.removeAttribute('src');
    this.video.load();

    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = '';
    }

    this.objectUrl = URL.createObjectURL(file);
    this.video.src = this.objectUrl;
    this.video.load();
    this.video.playbackRate = this.speed;
    this.applyPitch();

    await this.waitForMetadata();

    const duration = this.video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('无法读取视频时长，文件可能损坏或编码不受支持。');
    }

    this.duration = duration;
    this.loop = { a: 0, b: duration };
    this.loopCount = 0;
    this.onLoopCount(0);
    this.video.currentTime = 0;
    this.onTime(0, duration);

    return {
      duration,
      width: this.video.videoWidth,
      height: this.video.videoHeight,
    };
  }

  unload(): void {
    this.pause();
    this.stopTicking();
    this.stopFpsProbe();
    this.duration = 0;
    this.video.removeAttribute('src');
    this.video.load();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = '';
    }
  }

  async play(): Promise<void> {
    if (!this.duration) return;

    // 播放位置在循环区间之外或已经播完时，从 A 点 / 开头重新开始。
    if (this.isLoopActive() && this.video.currentTime >= this.loop.b - 0.01) {
      this.seek(this.loop.a);
    } else if (
      !this.isLoopActive() &&
      (this.video.ended || this.video.currentTime >= this.duration - 0.02)
    ) {
      this.seek(0);
    }

    try {
      await this.video.play();
    } catch {
      this.onPlayChange(false);
    }
  }

  pause(): void {
    if (!this.video.paused) this.video.pause();
  }

  async toggle(): Promise<void> {
    if (!this.duration) return;
    if (this.playing) {
      this.pause();
    } else {
      await this.play();
    }
  }

  isLoopActive(): boolean {
    return this.loopEnabled && this.loop.b - this.loop.a > 0.04;
  }

  setLoop(a: number, b: number): LoopRange {
    if (!this.duration) {
      this.loop = { a: 0, b: 0 };
      return this.loop;
    }

    let nextA = clamp(Number.isFinite(a) ? a : 0, 0, this.duration);
    let nextB = clamp(Number.isFinite(b) ? b : this.duration, 0, this.duration);
    if (nextB < nextA) {
      [nextA, nextB] = [nextB, nextA];
    }

    const minGap = Math.min(0.08, this.duration);
    if (nextB - nextA < minGap) {
      nextB = Math.min(this.duration, nextA + minGap);
      if (nextB - nextA < minGap) {
        nextA = Math.max(0, nextB - minGap);
      }
    }

    this.loop = { a: nextA, b: nextB };
    this.resetLoopCount();

    if (this.isLoopActive() && this.playing && this.video.currentTime >= nextB - 0.002) {
      this.seek(nextA);
    }

    return this.loop;
  }

  setLoopEnabled(enabled: boolean): void {
    this.loopEnabled = enabled;
    if (enabled && this.isLoopActive() && this.playing) {
      const t = this.video.currentTime;
      if (t >= this.loop.b - 0.002) this.seek(this.loop.a);
    }
  }

  setSpeed(rate: number): number {
    const next = clamp(Number.isFinite(rate) ? rate : 1, 0.0625, 16);
    this.speed = next;
    this.video.defaultPlaybackRate = next;
    this.video.playbackRate = next;
    return next;
  }

  setPitch(preserve: boolean): void {
    this.pitch = preserve;
    this.applyPitch();
  }

  seek(time: number): void {
    if (!this.duration) return;
    this.looping = false;
    const target = clamp(Number.isFinite(time) ? time : 0, 0, this.duration);
    this.video.currentTime = target;
    this.onTime(target, this.duration);
  }

  step(frames: number): void {
    if (!this.duration) return;
    if (this.playing) this.pause();
    this.seek(this.video.currentTime + frames / this.fps);
  }

  resetLoopCount(): void {
    if (this.loopCount !== 0) {
      this.loopCount = 0;
      this.onLoopCount(0);
    }
  }

  private applyPitch(): void {
    const video = this.video as HTMLVideoElement & {
      mozPreservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    video.preservesPitch = this.pitch;
    if ('mozPreservesPitch' in video) video.mozPreservesPitch = this.pitch;
    if ('webkitPreservesPitch' in video) video.webkitPreservesPitch = this.pitch;
  }

  private startTicking(): void {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(this.tick);
  }

  private stopTicking(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private tick = (): void => {
    this.rafId = 0;
    if (this.video.paused) {
      this.emitTime();
      return;
    }

    const time = this.video.currentTime;

    if (this.isLoopActive() && !this.looping) {
      // 提前半帧触发，减少慢放时越过 B 点的误差。
      const lead = Math.min(0.02, 0.5 / this.fps);
      if (time >= this.loop.b - lead) {
        this.looping = true;
        this.loopCount += 1;
        this.onLoopCount(this.loopCount);
        this.video.currentTime = this.loop.a;
        window.clearTimeout(this.loopResetTimer);
        this.loopResetTimer = window.setTimeout(() => {
          this.looping = false;
        }, 1200);
      }
    }

    this.emitTime();
    this.rafId = requestAnimationFrame(this.tick);
  };

  private emitTime(): void {
    this.onTime(this.video.currentTime, this.duration);
  }

  private handlePlay = (): void => {
    this.onPlayChange(true);
    this.startTicking();
    this.startFpsProbe();
  };

  private handlePause = (): void => {
    this.onPlayChange(false);
    this.stopTicking();
    this.stopFpsProbe();
    this.emitTime();
  };

  private handleSeeked = (): void => {
    this.looping = false;
    window.clearTimeout(this.loopResetTimer);
    this.emitTime();
  };

  private handleEnded = (): void => {
    if (this.isLoopActive()) {
      // 如果 rAF 已经处理过 B 点，这里不要重复计数。
      if (!this.looping) {
        this.loopCount += 1;
        this.onLoopCount(this.loopCount);
      }
      this.video.currentTime = this.loop.a;
      void this.video.play().catch(() => {
        this.onPlayChange(false);
      });
    } else {
      this.onPlayChange(false);
    }
  };

  private handleError = (): void => {
    if (!this.objectUrl) return;
    this.onError(this.describeError());
  };

  private describeError(): string {
    const error = this.video.error;
    if (!error) return '视频读取失败，请重试。';
    switch (error.code) {
      case MediaError.MEDIA_ERR_ABORTED:
        return '视频读取被中断，请重新打开文件。';
      case MediaError.MEDIA_ERR_NETWORK:
        return '视频读取失败，请确认文件仍然可用。';
      case MediaError.MEDIA_ERR_DECODE:
        return '视频解码失败，文件可能损坏。';
      case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
        return '浏览器无法播放这个视频。建议使用 H.264 编码的 MP4。';
      default:
        return '视频播放出错，请尝试其他格式。';
    }
  }

  private waitForMetadata(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        window.clearTimeout(timer);
        this.video.removeEventListener('loadedmetadata', onLoaded);
        this.video.removeEventListener('error', onError);
      };

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const onLoaded = (): void => finish(resolve);
      const onError = (): void => finish(() => reject(new Error(this.describeError())));
      const timer = window.setTimeout(() => {
        finish(() => reject(new Error('读取视频超时。文件可能过大，或浏览器不支持该编码。')));
      }, 15000);

      this.video.addEventListener('loadedmetadata', onLoaded);
      this.video.addEventListener('error', onError);
    });
  }

  private startFpsProbe(): void {
    if (this.fpsProbeDone || this.frameProbeId) return;
    const video = this.video as unknown as Partial<FrameApi>;
    if (typeof video.requestVideoFrameCallback !== 'function') return;

    this.lastMediaTime = null;

    const onFrame = (_now: number, metadata: { mediaTime: number }): void => {
      this.frameProbeId = 0;
      if (this.video.paused) return;

      const mediaTime = metadata.mediaTime;
      if (this.lastMediaTime !== null) {
        const delta = mediaTime - this.lastMediaTime;
        if (delta > 0.001 && delta < 0.2) this.frameSamples.push(delta);
      }
      this.lastMediaTime = mediaTime;

      if (this.frameSamples.length >= 20) {
        this.finishFpsProbe();
        return;
      }

      this.frameProbeId = video.requestVideoFrameCallback!(onFrame);
    };

    this.frameProbeId = video.requestVideoFrameCallback!(onFrame);
  }

  private stopFpsProbe(): void {
    const video = this.video as unknown as Partial<FrameApi>;
    if (this.frameProbeId && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(this.frameProbeId);
    }
    this.frameProbeId = 0;
    this.lastMediaTime = null;
  }

  private finishFpsProbe(): void {
    this.stopFpsProbe();

    const samples = [...this.frameSamples].sort((a, b) => a - b);
    this.frameSamples = [];
    if (samples.length < 8) return;

    const median = samples[Math.floor(samples.length / 2)];
    if (!median) return;
    const raw = 1 / median;
    if (!Number.isFinite(raw) || raw < 5 || raw > 500) return;

    const candidates = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
    let detected = 0;
    for (const candidate of candidates) {
      if (Math.abs(raw - candidate) / candidate < 0.08) {
        detected = candidate;
        break;
      }
    }
    if (!detected) {
      const rounded = Math.round(raw);
      if (rounded >= 20 && rounded <= 144) detected = rounded;
    }

    if (detected) {
      this.fps = detected;
      this.fpsProbeDone = true;
      this.onFps(detected);
    }
  }

  dispose(): void {
    this.pause();
    this.stopTicking();
    this.stopFpsProbe();
    window.clearTimeout(this.loopResetTimer);
    this.video.removeEventListener('play', this.handlePlay);
    this.video.removeEventListener('pause', this.handlePause);
    this.video.removeEventListener('seeked', this.handleSeeked);
    this.video.removeEventListener('ended', this.handleEnded);
    this.video.removeEventListener('error', this.handleError);
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
}
