import './style.css';
import { Player, type VideoInfo } from './player';
import { StageView } from './viewport';
import { Timeline } from './timeline';
import { generateThumbnails } from './thumbnails';
import {
  clamp,
  formatBytes,
  formatTime,
  isTypingTarget,
  isVideoFile,
  loadSettings,
  round,
  saveSettings,
  setRangeFill,
  type SizeMode,
} from './utils';

/* ------------------------------------------------------------------ */
/* Elements                                                            */
/* ------------------------------------------------------------------ */

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const video = el<HTMLVideoElement>('video');
const stage = el('stage');
const viewport = el('viewport');
const capture = el('capture');
const captureRect = el('capture-rect');
const empty = el('empty');
const stageHud = el('stage-hud');
const stageLoading = el('stage-loading');
const dropOverlay = el('drop-overlay');

const fileBar = el('file-bar');
const fileName = el('file-name');
const fileMeta = el('file-meta');

const timelineRoot = el('timeline');
const timeline = new Timeline(
  timelineRoot,
  el('tl-thumbs'),
  el('tl-loop'),
  el('tl-shade-left'),
  el('tl-shade-right'),
  el('tl-playhead'),
  el('tl-handle-a'),
  el('tl-handle-b'),
  el('tl-tip'),
  el('tl-duration'),
);

const tcCurrent = el('tc-current');
const tcDuration = el('tc-duration');
const transportLoop = el('transport-loop');
const loopCount = el('loop-count');
const loopCountNum = el('loop-count-num');
const btnPlay = el<HTMLButtonElement>('btn-play');
const btnLoop = el<HTMLButtonElement>('btn-loop');
const btnMirror = el<HTMLButtonElement>('btn-mirror');
const btnRegion = el<HTMLButtonElement>('btn-region');
const btnMute = el<HTMLButtonElement>('btn-mute');
const btnMuteHud = el<HTMLButtonElement>('btn-mute-hud');
const btnZoomHud = el<HTMLButtonElement>('btn-zoom-hud');
const btnSpeedHud = el<HTMLButtonElement>('btn-speed-hud');
const zoomHudValue = el('zoom-hud-value');

const speedReadout = el('speed-readout');
const speedRange = el<HTMLInputElement>('speed-range');
const speedInput = el<HTMLInputElement>('speed-input');
const pitchToggle = el<HTMLInputElement>('pitch-toggle');
const loopEnabled = el<HTMLInputElement>('loop-enabled');
const aTime = el('a-time');
const bTime = el('b-time');
const loopLength = el('loop-length');

const zoomReadout = el('zoom-readout');
const zoomValue = el('zoom-value');
const zoomRange = el<HTMLInputElement>('zoom-range');
const sizeRange = el<HTMLInputElement>('size-range');
const sizeValue = el('size-value');
const mirrorToggle = el<HTMLInputElement>('mirror-toggle');

const fileInput = el<HTMLInputElement>('file-input');
const toast = el('toast');
const helpDialog = el<HTMLDialogElement>('help-dialog');

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const settings = loadSettings();
let currentFile: File | null = null;
let videoInfo: VideoInfo | null = null;
let hasVideo = false;
let loading = false;
let scrubbing = false;
let wasPlayingBeforeScrub = false;
let loadToken = 0;

let toastTimer = 0;
let saveTimer = 0;
let thumbTimer = 0;
let thumbAbort: AbortController | null = null;

/* ------------------------------------------------------------------ */
/* Core objects                                                        */
/* ------------------------------------------------------------------ */

const player = new Player(video);
const view = new StageView(stage, viewport, video, capture, captureRect);

video.addEventListener('loadeddata', () => {
  if (hasVideo) view.refresh();
});

player.setSpeed(settings.speed);
player.setPitch(settings.pitch);
player.setLoopEnabled(settings.loopEnabled);
video.muted = settings.muted;

view.setMode(settings.sizeMode, settings.sizePercent);
view.setMirror(settings.mirror);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function showToast(message: string, isError = false, duration = 2600): void {
  toast.textContent = message;
  toast.classList.toggle('is-error', isError);
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove('is-visible');
  }, duration);
}

function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveSettings(settings), 280);
}

function setControlsEnabled(enabled: boolean): void {
  document
    .querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-needs-video]')
    .forEach((node) => {
      node.disabled = !enabled;
    });
  if (enabled) updateSizeUI();
}

function iconUse(button: HTMLElement, symbol: string): void {
  const use = button.querySelector('use');
  if (use) use.setAttribute('href', symbol);
}

function activatePanelTab(tab: string): void {
  document.querySelectorAll<HTMLButtonElement>('.panel-tab').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll<HTMLElement>('.panel-section').forEach((section) => {
    section.classList.toggle('is-active', section.dataset.panel === tab);
  });
  el('panel').scrollTop = 0;
}

/* ------------------------------------------------------------------ */
/* UI sync                                                             */
/* ------------------------------------------------------------------ */

function updateSpeedUI(): void {
  const speed = player.playbackSpeed;
  speedReadout.textContent = speed.toFixed(2);
  speedRange.value = String(speed);
  setRangeFill(speedRange);
  if (document.activeElement !== speedInput) {
    speedInput.value = speed.toFixed(2);
  }
  document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => {
    const value = Number(button.dataset.speed);
    button.classList.toggle('is-active', Math.abs(value - speed) < 0.005);
  });
  btnSpeedHud.textContent = `${speed.toFixed(2)}×`;
}

function updateLoopUI(): void {
  const { a, b } = player.loop;
  aTime.textContent = formatTime(a, 3);
  bTime.textContent = formatTime(b, 3);
  loopLength.textContent = `片段 ${(b - a).toFixed(2)} 秒`;

  loopEnabled.checked = player.loopEnabled;
  btnLoop.classList.toggle('is-active', player.loopEnabled);
  timeline.setLoop(a, b, player.loopEnabled);
}

function updateLoopCount(count: number): void {
  const visible = count > 0;
  loopCount.hidden = !visible;
  transportLoop.hidden = !visible;
  loopCountNum.textContent = String(count);
  transportLoop.textContent = `循环 ×${count}`;
}

function updatePlayUI(playing: boolean): void {
  btnPlay.classList.toggle('is-playing', playing);
  btnPlay.setAttribute('aria-label', playing ? '暂停' : '播放');
  iconUse(btnPlay, playing ? '#i-pause' : '#i-play');
}

function updateMirrorUI(): void {
  mirrorToggle.checked = settings.mirror;
  btnMirror.classList.toggle('is-active', settings.mirror);
  btnMirror.setAttribute('aria-pressed', String(settings.mirror));
}

function updateMuteUI(): void {
  for (const button of [btnMute, btnMuteHud]) {
    button.classList.toggle('is-active', video.muted);
    button.setAttribute('aria-label', video.muted ? '取消静音' : '静音');
    button.title = video.muted ? '取消静音 (M)' : '静音 (M)';
    iconUse(button, video.muted ? '#i-mute' : '#i-volume');
  }
}

function updateSizeUI(): void {
  const custom = settings.sizeMode === 'custom';
  const block = sizeRange.closest<HTMLElement>('.size-block');

  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.mode === settings.sizeMode);
  });

  sizeRange.value = String(settings.sizePercent);
  sizeValue.textContent = `${Math.round(settings.sizePercent)}%`;
  setRangeFill(sizeRange);
  sizeRange.disabled = !hasVideo || !custom;
  block?.classList.toggle('is-enabled', custom);
}

function updateZoomUI(scale: number): void {
  const value = round(scale, 2);
  zoomReadout.textContent = `${value.toFixed(2)}×`;
  zoomValue.textContent = `${value.toFixed(2)}×`;
  zoomRange.value = String(value);
  setRangeFill(zoomRange);

  const zoomed = scale > 1.02;
  btnZoomHud.hidden = !zoomed;
  if (zoomed) zoomHudValue.textContent = `${scale.toFixed(1)}×`;
  stage.classList.toggle('is-zoomed', zoomed);
}

function updateFileMeta(): void {
  if (!currentFile || !videoInfo) {
    fileMeta.textContent = '';
    return;
  }
  const fps = round(player.fps, player.fps % 1 === 0 ? 0 : 2);
  fileMeta.textContent = `${videoInfo.width}×${videoInfo.height} · ${formatBytes(
    currentFile.size,
  )} · ≈${fps} fps`;
}

function fullscreenElement(): Element | null {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function updateFullscreenUI(): void {
  const active = Boolean(fullscreenElement());
  document.querySelectorAll<HTMLElement>('[data-fullscreen]').forEach((button) => {
    iconUse(button, active ? '#i-collapse' : '#i-expand');
    button.title = active ? '退出全屏 (F)' : '全屏 (F)';
    button.setAttribute('aria-label', active ? '退出全屏' : '全屏');
  });
}

/* ------------------------------------------------------------------ */
/* Screen wake lock（练习时保持屏幕常亮）                              */
/* ------------------------------------------------------------------ */

interface WakeLockLike {
  release: () => Promise<void>;
}

let wakeLock: WakeLockLike | null = null;

async function acquireWakeLock(): Promise<void> {
  if (wakeLock || !window.isSecureContext || document.visibilityState !== 'visible') return;
  const nav = navigator as Navigator & {
    wakeLock?: { request: (type: 'screen') => Promise<WakeLockLike> };
  };
  if (!nav.wakeLock) return;
  try {
    wakeLock = await nav.wakeLock.request('screen');
  } catch {
    wakeLock = null;
  }
}

async function releaseWakeLock(): Promise<void> {
  const lock = wakeLock;
  wakeLock = null;
  if (!lock) return;
  try {
    await lock.release();
  } catch {
    /* ignore */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void releaseWakeLock();
  } else if (player.playing) {
    void acquireWakeLock();
  }
});

/* ------------------------------------------------------------------ */
/* Player events                                                       */
/* ------------------------------------------------------------------ */

player.onTime = (time, duration) => {
  if (!scrubbing) {
    timeline.setTime(time);
    tcCurrent.textContent = formatTime(time, 3);
  }
  if (duration > 0) tcDuration.textContent = formatTime(duration, 3);
};

player.onPlayChange = (playing) => {
  updatePlayUI(playing);
  if (playing) void acquireWakeLock();
  else void releaseWakeLock();
};

player.onLoopCount = (count) => {
  updateLoopCount(count);
};

player.onFps = () => {
  updateFileMeta();
};

player.onError = (message) => {
  showToast(message, true, 6000);
};

/* ------------------------------------------------------------------ */
/* Timeline events                                                     */
/* ------------------------------------------------------------------ */

timeline.onSeek = (time) => {
  player.seek(time);
  tcCurrent.textContent = formatTime(time, 3);
};

timeline.onScrubStart = () => {
  wasPlayingBeforeScrub = player.playing;
  if (wasPlayingBeforeScrub) player.pause();
  scrubbing = true;
};

timeline.onScrubEnd = () => {
  scrubbing = false;
  if (wasPlayingBeforeScrub) {
    void player.play();
  }
  wasPlayingBeforeScrub = false;
};

timeline.onLoopChange = (a, b) => {
  player.setLoop(a, b);
  if (!player.loopEnabled) {
    player.setLoopEnabled(true);
    settings.loopEnabled = true;
    scheduleSave();
  }
  updateLoopUI();
};

/* ------------------------------------------------------------------ */
/* Stage events                                                        */
/* ------------------------------------------------------------------ */

view.onTap = () => {
  if (hasVideo) void player.toggle();
};

view.onTransform = (scale) => {
  updateZoomUI(scale);
};

view.onRegionModeChange = (active) => {
  btnRegion.classList.toggle('is-active', active);
  const region2 = document.getElementById('btn-region-2');
  region2?.classList.toggle('is-active', active);
  if (active) {
    activatePanelTab('view');
    showToast('拖动框选要放大的区域', false, 1800);
  }
};

/* ------------------------------------------------------------------ */
/* Playback controls                                                   */
/* ------------------------------------------------------------------ */

btnPlay.addEventListener('click', () => {
  void player.toggle();
});

el('btn-step-back').addEventListener('click', () => player.step(-1));
el('btn-step-fwd').addEventListener('click', () => player.step(1));

btnMute.addEventListener('click', () => {
  setMuted(!video.muted);
});

btnMuteHud.addEventListener('click', () => {
  setMuted(!video.muted);
});

function setMuted(muted: boolean, persist = true): void {
  video.muted = muted;
  settings.muted = muted;
  updateMuteUI();
  if (persist) scheduleSave();
}

/* ------------------------------------------------------------------ */
/* Speed                                                               */
/* ------------------------------------------------------------------ */

function applySpeed(rate: number, persist = true): void {
  const next = clamp(round(Number.isFinite(rate) ? rate : 1, 2), 0.1, 2);
  player.setSpeed(next);
  settings.speed = next;
  updateSpeedUI();
  if (persist) scheduleSave();
}

document.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((button) => {
  button.addEventListener('click', () => {
    applySpeed(Number(button.dataset.speed));
  });
});

speedRange.addEventListener('input', () => {
  applySpeed(Number(speedRange.value));
});

speedInput.addEventListener('input', () => {
  const value = Number(speedInput.value);
  if (Number.isFinite(value) && value >= 0.1 && value <= 2) {
    applySpeed(value);
  }
});

speedInput.addEventListener('change', () => {
  const value = Number(speedInput.value);
  if (!Number.isFinite(value) || value <= 0) {
    updateSpeedUI();
    return;
  }
  applySpeed(value);
});

speedInput.addEventListener('blur', () => updateSpeedUI());

el('speed-dec').addEventListener('click', () => applySpeed(player.playbackSpeed - 0.05));
el('speed-inc').addEventListener('click', () => applySpeed(player.playbackSpeed + 0.05));

pitchToggle.addEventListener('change', () => {
  player.setPitch(pitchToggle.checked);
  settings.pitch = pitchToggle.checked;
  scheduleSave();
});

/* ------------------------------------------------------------------ */
/* Loop                                                                */
/* ------------------------------------------------------------------ */

function setLoopEnabled(enabled: boolean, announce = true): void {
  player.setLoopEnabled(enabled);
  settings.loopEnabled = enabled;
  updateLoopUI();
  scheduleSave();
  if (announce) {
    showToast(enabled ? 'A-B 循环已开启' : 'A-B 循环已关闭', false, 1400);
  }
}

function ensureLoopEnabled(): void {
  if (!player.loopEnabled) {
    player.setLoopEnabled(true);
    settings.loopEnabled = true;
    scheduleSave();
  }
}

btnLoop.addEventListener('click', () => {
  setLoopEnabled(!player.loopEnabled);
});

loopEnabled.addEventListener('change', () => {
  setLoopEnabled(loopEnabled.checked);
});

el('set-a').addEventListener('click', () => setPoint('a'));
el('set-b').addEventListener('click', () => setPoint('b'));

function setPoint(which: 'a' | 'b'): void {
  if (!hasVideo) return;
  const time = player.currentTime;
  const { a, b } = player.loop;

  if (which === 'a') {
    player.setLoop(clamp(Math.min(time, b - 0.08), 0, player.duration), b);
  } else {
    player.setLoop(a, clamp(Math.max(time, a + 0.08), 0, player.duration));
  }

  ensureLoopEnabled();
  updateLoopUI();
  scheduleSave();
  showToast(
    `${which.toUpperCase()} 点 · ${formatTime(which === 'a' ? player.loop.a : player.loop.b, 3)}`,
    false,
    1300,
  );
}

function nudgePoint(which: 'a' | 'b', direction: number): void {
  if (!hasVideo) return;
  const step = direction / player.fps;
  const { a, b } = player.loop;
  if (which === 'a') {
    player.setLoop(clamp(a + step, 0, b - 0.08), b);
  } else {
    player.setLoop(a, clamp(b + step, a + 0.08, player.duration));
  }
  ensureLoopEnabled();
  updateLoopUI();
  scheduleSave();
}

el('a-nudge-back').addEventListener('click', () => nudgePoint('a', -1));
el('a-nudge-fwd').addEventListener('click', () => nudgePoint('a', 1));
el('b-nudge-back').addEventListener('click', () => nudgePoint('b', -1));
el('b-nudge-fwd').addEventListener('click', () => nudgePoint('b', 1));

el('loop-goto-a').addEventListener('click', () => {
  player.seek(player.loop.a);
});

el('loop-full').addEventListener('click', () => {
  player.setLoop(0, player.duration);
  ensureLoopEnabled();
  updateLoopUI();
  scheduleSave();
});

/* ------------------------------------------------------------------ */
/* View: size / zoom / region / mirror / fullscreen                    */
/* ------------------------------------------------------------------ */

function setSizeMode(mode: SizeMode, percent = settings.sizePercent): void {
  settings.sizeMode = mode;
  settings.sizePercent = clamp(percent, 25, 150);
  view.setMode(mode, settings.sizePercent);
  updateSizeUI();
  updateZoomUI(view.scaleValue);
  scheduleSave();
}

document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    const mode = button.dataset.mode as SizeMode | undefined;
    if (mode === 'fit' || mode === 'fill' || mode === 'custom') {
      setSizeMode(mode);
    }
  });
});

sizeRange.addEventListener('input', () => {
  const percent = clamp(Number(sizeRange.value), 25, 150);
  settings.sizePercent = percent;
  if (settings.sizeMode !== 'custom') {
    settings.sizeMode = 'custom';
    view.setMode('custom', percent);
  } else {
    view.setPercent(percent);
  }
  sizeValue.textContent = `${Math.round(percent)}%`;
  setRangeFill(sizeRange);
  updateSizeUI();
  updateZoomUI(view.scaleValue);
  scheduleSave();
});

zoomRange.addEventListener('input', () => {
  view.setZoom(Number(zoomRange.value));
});

function resetZoom(): void {
  view.resetZoom(true);
}

el('btn-zoom-reset').addEventListener('click', resetZoom);
el('btn-zoom-hud').addEventListener('click', resetZoom);
el('zoom-range').addEventListener('dblclick', resetZoom);

btnRegion.addEventListener('click', () => {
  view.toggleRegionMode();
});

document.getElementById('btn-region-2')?.addEventListener('click', () => {
  view.toggleRegionMode();
});

function setMirror(mirror: boolean, persist = true): void {
  settings.mirror = mirror;
  view.setMirror(mirror);
  updateMirrorUI();
  if (persist) scheduleSave();
}

btnMirror.addEventListener('click', () => {
  setMirror(!settings.mirror);
});

mirrorToggle.addEventListener('change', () => {
  setMirror(mirrorToggle.checked);
});

async function toggleFullscreen(): Promise<void> {
  const doc = document as Document & {
    webkitFullscreenElement?: Element | null;
    webkitFullscreenEnabled?: boolean;
    webkitExitFullscreen?: () => Promise<void> | void;
  };
  const root = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
  };
  const supported =
    document.fullscreenEnabled || doc.webkitFullscreenEnabled || Boolean(root.webkitRequestFullscreen);

  if (!supported) {
    showToast('当前浏览器不支持全屏模式', true);
    return;
  }

  try {
    if (fullscreenElement()) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
    } else if (root.requestFullscreen) {
      await root.requestFullscreen();
    } else if (root.webkitRequestFullscreen) {
      await root.webkitRequestFullscreen();
    }
  } catch {
    showToast('无法进入全屏模式', true);
  }
}

document.querySelectorAll<HTMLElement>('[data-fullscreen]').forEach((button) => {
  button.addEventListener('click', () => {
    void toggleFullscreen();
  });
});

document.addEventListener('fullscreenchange', updateFullscreenUI);
document.addEventListener('webkitfullscreenchange', updateFullscreenUI);

/* ------------------------------------------------------------------ */
/* File loading                                                        */
/* ------------------------------------------------------------------ */

function pickFile(): void {
  fileInput.value = '';
  fileInput.click();
}

el('btn-open').addEventListener('click', pickFile);
el('btn-open-empty').addEventListener('click', pickFile);

empty.addEventListener('click', (event) => {
  if (!(event.target as HTMLElement | null)?.closest('button')) pickFile();
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
});

async function openFile(file: File): Promise<void> {
  if (loading) {
    showToast('视频正在读取中，请稍候…', false, 1600);
    return;
  }
  if (!isVideoFile(file)) {
    showToast('请选择视频文件（MP4 / MOV / WebM）', true, 3200);
    return;
  }

  loading = true;
  const token = (loadToken += 1);
  stageLoading.hidden = false;

  thumbAbort?.abort();
  thumbAbort = null;
  window.clearTimeout(thumbTimer);

  try {
    const info = await player.load(file);
    if (token !== loadToken) return;

    currentFile = file;
    videoInfo = info;
    hasVideo = true;

    player.setSpeed(settings.speed);
    player.setPitch(settings.pitch);
    player.setLoopEnabled(settings.loopEnabled);
    player.setLoop(0, info.duration);
    video.muted = settings.muted;

    view.setReady(true);
    view.setMirror(settings.mirror);

    empty.hidden = true;
    stageHud.hidden = false;
    fileBar.classList.add('has-file');
    fileName.textContent = file.name;
    fileMeta.textContent = '';
    document.title = `${file.name} · Dance Loop`;

    setControlsEnabled(true);
    timeline.setDuration(info.duration);
    timeline.setLoop(0, info.duration, player.loopEnabled);
    timeline.setTime(0);

    updateFileMeta();
    updateSpeedUI();
    updateLoopUI();
    updateLoopCount(0);
    updateMirrorUI();
    updateMuteUI();
    updateSizeUI();
    updateZoomUI(view.scaleValue);
    updatePlayUI(false);

    tcCurrent.textContent = formatTime(0, 3);
    tcDuration.textContent = formatTime(info.duration, 3);

    startThumbnails();
    showToast(`已加载 · ${formatTime(info.duration, 0)}`, false, 1600);
  } catch (error) {
    if (token !== loadToken) return;
    resetToEmpty();
    const message =
      error instanceof Error ? error.message : '视频加载失败，请尝试其他文件。';
    showToast(message, true, 6000);
  } finally {
    if (token === loadToken) {
      loading = false;
      stageLoading.hidden = true;
    }
  }
}

function startThumbnails(): void {
  if (!hasVideo || !player.sourceUrl) return;

  thumbAbort?.abort();
  window.clearTimeout(thumbTimer);

  const count = window.innerWidth < 760 ? 14 : 22;
  timeline.clearThumbnails();
  const controller = new AbortController();
  thumbAbort = controller;

  thumbTimer = window.setTimeout(() => {
    if (controller.signal.aborted || !player.duration || !player.sourceUrl) return;
    void generateThumbnails(
      player.sourceUrl,
      player.duration,
      count,
      (index, url) => timeline.setThumbnail(index, url, count),
      controller.signal,
    )
      .catch(() => {
        /* 缩略图失败不影响播放 */
      })
      .finally(() => {
        if (!controller.signal.aborted) timeline.finishThumbnails();
      });
  }, 260);
}

function resetToEmpty(): void {
  hasVideo = false;
  currentFile = null;
  videoInfo = null;
  loading = false;

  thumbAbort?.abort();
  thumbAbort = null;
  window.clearTimeout(thumbTimer);

  player.unload();
  view.setReady(false);
  timeline.reset();
  setControlsEnabled(false);

  empty.hidden = false;
  stageHud.hidden = true;
  stageLoading.hidden = true;
  dropOverlay.hidden = true;
  fileBar.classList.remove('has-file');
  fileName.textContent = '未加载视频';
  fileMeta.textContent = '';
  tcCurrent.textContent = formatTime(0, 3);
  tcDuration.textContent = formatTime(0, 3);
  document.title = 'Dance Loop · 扒舞练习器';

  updateLoopCount(0);
  updateLoopUI();
  updatePlayUI(false);
  updateSpeedUI();
  updateZoomUI(1);
  updateSizeUI();
  updateMirrorUI();
  updateMuteUI();
}

/* ------------------------------------------------------------------ */
/* Drag & drop                                                         */
/* ------------------------------------------------------------------ */

let dragDepth = 0;

function showDrop(show: boolean): void {
  dropOverlay.hidden = !show;
  stage.classList.toggle('is-drag-over', show);
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  if (!loading) showDrop(true);
});

window.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) showDrop(false);
});

window.addEventListener('dragend', () => {
  dragDepth = 0;
  showDrop(false);
});

window.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  showDrop(false);

  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;
  const file = Array.from(files).find((candidate) => isVideoFile(candidate));
  if (!file) {
    showToast('拖入的不是视频文件', true, 3000);
    return;
  }
  void openFile(file);
});

/* ------------------------------------------------------------------ */
/* Tabs / help / shortcuts                                             */
/* ------------------------------------------------------------------ */

document.querySelectorAll<HTMLButtonElement>('.panel-tab').forEach((button) => {
  button.addEventListener('click', () => {
    const tab = button.dataset.tab;
    if (tab) activatePanelTab(tab);
  });
});

btnSpeedHud.addEventListener('click', () => {
  activatePanelTab('speed');
});

const btnHelp = el<HTMLButtonElement>('btn-help');

btnHelp.addEventListener('click', () => {
  if (!helpDialog.open) helpDialog.showModal();
});

el('btn-help-2').addEventListener('click', () => {
  if (!helpDialog.open) helpDialog.showModal();
});

el('help-close').addEventListener('click', () => helpDialog.close());

helpDialog.addEventListener('click', (event) => {
  if (event.target === helpDialog) helpDialog.close();
});

document.addEventListener('keydown', (event) => {
  if (isTypingTarget(event.target)) return;
  if (helpDialog.open) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  const key = event.key;
  const lower = key.toLowerCase();

  if (key === ' ' || key === 'Spacebar') {
    event.preventDefault();
    if (hasVideo) void player.toggle();
    return;
  }

  if (key === '?') {
    event.preventDefault();
    if (!helpDialog.open) helpDialog.showModal();
    return;
  }

  if (key === 'Escape') {
    if (view.regionMode) view.exitRegionMode();
    return;
  }

  if (!hasVideo) return;

  switch (key) {
    case 'ArrowLeft':
      event.preventDefault();
      if (event.shiftKey) player.seek(player.currentTime - 1);
      else player.step(-1);
      break;
    case 'ArrowRight':
      event.preventDefault();
      if (event.shiftKey) player.seek(player.currentTime + 1);
      else player.step(1);
      break;
    case '0':
      event.preventDefault();
      resetZoom();
      break;
    default:
      break;
  }

  switch (lower) {
    case 'a':
      setPoint('a');
      break;
    case 'b':
      setPoint('b');
      break;
    case 'l':
      setLoopEnabled(!player.loopEnabled);
      break;
    case 'z':
      view.toggleRegionMode();
      break;
    case 'v':
      setMirror(!settings.mirror);
      break;
    case 'm':
      setMuted(!video.muted);
      break;
    case 'f':
      void toggleFullscreen();
      break;
    case '[':
      applySpeed(player.playbackSpeed - 0.05);
      break;
    case ']':
      applySpeed(player.playbackSpeed + 0.05);
      break;
    case '1':
      applySpeed(0.3);
      break;
    case '2':
      applySpeed(0.5);
      break;
    case '3':
      applySpeed(0.75);
      break;
    case '4':
      applySpeed(1);
      break;
    default:
      break;
  }
});

/* ------------------------------------------------------------------ */
/* Initial paint                                                       */
/* ------------------------------------------------------------------ */

pitchToggle.checked = settings.pitch;
setControlsEnabled(false);
timeline.reset();
updateSpeedUI();
updateLoopUI();
updateMirrorUI();
updateMuteUI();
updateSizeUI();
updateZoomUI(1);
updateFullscreenUI();
updatePlayUI(false);
video.muted = settings.muted;

/* PWA：只在 HTTPS / localhost 下注册，避免局域网 HTTP 访问时报错。 */
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener(
    'load',
    () => {
      navigator.serviceWorker
        .register(new URL('sw.js', document.baseURI))
        .catch(() => {
          /* 注册失败不影响播放 */
        });
    },
    { once: true },
  );
}

window.addEventListener('pagehide', () => {
  saveSettings(settings);
});

window.addEventListener('beforeunload', () => {
  void releaseWakeLock();
  player.dispose();
  view.dispose();
  timeline.dispose();
});
