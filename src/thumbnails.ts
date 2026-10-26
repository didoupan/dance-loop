/**
 * 用第二个隐藏 video 解码视频，按均匀间隔截取缩略图，供时间轴显示。
 */
export async function generateThumbnails(
  source: string,
  duration: number,
  count: number,
  onThumb: (index: number, dataUrl: string) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!source || duration <= 0 || count <= 0) return;

  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.src = source;

  try {
    await waitForEvent(video, 'loadedmetadata', 8000, signal);
    if (video.readyState < 2) {
      await waitForEvent(video, 'loadeddata', 8000, signal);
    }
    if (signal.aborted) return;

    const width = 180;
    const aspect = video.videoWidth && video.videoHeight ? video.videoHeight / video.videoWidth : 9 / 16;
    const height = Math.max(1, Math.round(width * aspect));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;

    for (let i = 0; i < count; i += 1) {
      if (signal.aborted) return;
      const ratio = (i + 0.5) / count;
      const time = Math.min(duration - 0.04, Math.max(0, ratio * duration));
      await seekVideo(video, time, signal);
      if (signal.aborted) return;

      try {
        context.drawImage(video, 0, 0, width, height);
        const url = canvas.toDataURL('image/jpeg', 0.55);
        onThumb(i, url);
      } catch {
        // 某些受保护视频无法绘制到 canvas，直接跳过。
      }

      // 让出主线程，避免影响播放控件。
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  } finally {
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      /* ignore */
    }
  }
}

function waitForEvent(
  target: HTMLVideoElement,
  event: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let finished = false;

    const cleanup = (): void => {
      window.clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      target.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };

    const finish = (fn: () => void): void => {
      if (finished) return;
      finished = true;
      cleanup();
      fn();
    };

    const onEvent = (): void => finish(resolve);
    const onError = (): void => finish(() => reject(new Error('缩略图解码失败')));
    const onAbort = (): void => finish(resolve);
    const timer = window.setTimeout(() => finish(resolve), timeoutMs);

    target.addEventListener(event, onEvent);
    target.addEventListener('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function seekVideo(video: HTMLVideoElement, time: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  if (Math.abs(video.currentTime - time) < 0.002 && video.readyState >= 2) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let finished = false;

    const cleanup = (): void => {
      window.clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      signal.removeEventListener('abort', onAbort);
    };

    const finish = (): void => {
      if (finished) return;
      finished = true;
      cleanup();
      // 等一帧，确保解码后的画面已就绪。
      requestAnimationFrame(() => resolve());
    };

    const onSeeked = (): void => finish();
    const onAbort = (): void => finish();
    const timer = window.setTimeout(finish, 1800);

    video.addEventListener('seeked', onSeeked);
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      video.currentTime = time;
    } catch {
      finish();
    }
  });
}
