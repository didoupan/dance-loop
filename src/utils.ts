export type SizeMode = 'fit' | 'fill' | 'custom';

export interface Settings {
  speed: number;
  pitch: boolean;
  mirror: boolean;
  loopEnabled: boolean;
  sizeMode: SizeMode;
  sizePercent: number;
  muted: boolean;
}

const SETTINGS_KEY = 'dance-loop.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  speed: 1,
  pitch: true,
  mirror: false,
  loopEnabled: true,
  sizeMode: 'fit',
  sizePercent: 100,
  muted: false,
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * 把秒数格式化成 m:ss.mmm（超过一小时则 h:mm:ss.mmm）。
 */
export function formatTime(seconds: number, decimals = 3): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const factor = 10 ** decimals;
  const total = Math.round(safe * factor);
  const whole = Math.floor(total / factor);
  const fraction = total % factor;

  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;

  const fractionText = decimals > 0 ? `.${String(fraction).padStart(decimals, '0')}` : '';

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${fractionText}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}${fractionText}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}

export function setRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Number(input.value) || 0;
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${clamp(percent, 0, 100)}%`);
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const mode: SizeMode =
      parsed.sizeMode === 'fill' || parsed.sizeMode === 'custom' ? parsed.sizeMode : 'fit';

    return {
      speed: clamp(Number(parsed.speed) || DEFAULT_SETTINGS.speed, 0.1, 2),
      pitch: parsed.pitch !== false,
      mirror: parsed.mirror === true,
      loopEnabled: parsed.loopEnabled !== false,
      sizeMode: mode,
      sizePercent: clamp(Number(parsed.sizePercent) || 100, 25, 150),
      muted: parsed.muted === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* localStorage 可能被禁用，不影响使用 */
  }
}

export function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  return /\.(mp4|m4v|mov|webm|ogv|mkv|avi)$/i.test(file.name);
}
