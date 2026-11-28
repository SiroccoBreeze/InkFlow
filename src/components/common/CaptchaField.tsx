import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

const CAPTCHA_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CANVAS_WIDTH = 108;
const CANVAS_HEIGHT = 44;

function randomIndex(max: number): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] % max;
  }
  return Math.floor(Math.random() * max);
}

export function generateCaptchaCode(length = 4): string {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CAPTCHA_CHARS[randomIndex(CAPTCHA_CHARS.length)];
  }
  return code;
}

export interface CaptchaState {
  code: string;
  value: string;
  setValue: (value: string) => void;
  refresh: () => void;
  validate: () => boolean;
}

/**
 * Captcha state shared by every auth surface. The code lives client-side by
 * design (it is a lightweight human check, not a server-side security
 * boundary); the important part is that it survives mode switches correctly.
 */
export function useCaptcha(length = 4): CaptchaState {
  const [code, setCode] = useState(() => generateCaptchaCode(length));
  const [value, setValue] = useState('');

  const refresh = useCallback(() => {
    setCode(generateCaptchaCode(length));
    setValue('');
  }, [length]);

  const validate = useCallback(
    () => value.trim().toUpperCase() === code.toUpperCase(),
    [code, value]
  );

  return { code, value, setValue, refresh, validate };
}

/**
 * Redraw whenever the app toggles `html.dark`. The previous implementation read
 * the theme once per draw, so switching themes left a stale (often unreadable)
 * canvas behind.
 */
function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(root.classList.contains('dark'));
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

function drawCaptcha(canvas: HTMLCanvasElement, code: string, isDark: boolean): void {
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 1;
  // Match the bitmap to the size the browser actually laid out (the button
  // border leaves a couple of pixels less than the nominal canvas size), so
  // the code is never resampled and stays crisp.
  const width = canvas.clientWidth || CANVAS_WIDTH;
  const height = canvas.clientHeight || CANVAS_HEIGHT;

  // Keep the bitmap sharp on HiDPI screens while CSS controls the layout size.
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = isDark ? '#171717' : '#f4f4f5';
  ctx.fillRect(0, 0, width, height);

  // Soft wave in the background
  ctx.beginPath();
  ctx.moveTo(0, height * 0.6);
  ctx.bezierCurveTo(width * 0.3, height * 0.25, width * 0.7, height * 0.85, width, height * 0.45);
  ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(24, 24, 27, 0.06)';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Noise dots
  for (let i = 0; i < 22; i += 1) {
    ctx.beginPath();
    ctx.arc(
      Math.random() * width,
      Math.random() * height,
      Math.random() * 1.2 + 0.4,
      0,
      Math.PI * 2
    );
    ctx.fillStyle = isDark ? 'rgba(212, 212, 216, 0.35)' : 'rgba(82, 82, 91, 0.22)';
    ctx.fill();
  }

  // Interference lines
  for (let i = 0; i < 3; i += 1) {
    ctx.beginPath();
    ctx.moveTo(Math.random() * width, Math.random() * height);
    ctx.lineTo(Math.random() * width, Math.random() * height);
    ctx.strokeStyle = isDark ? 'rgba(161, 161, 170, 0.28)' : 'rgba(82, 82, 91, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const colors = isDark
    ? ['#7dd3fc', '#6ee7b7', '#fcd34d', '#f9a8d4', '#c4b5fd']
    : ['#0369a1', '#047857', '#b45309', '#be123c', '#6d28d9'];

  ctx.font = '700 24px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const step = width / (code.length + 1);
  for (let i = 0; i < code.length; i += 1) {
    const x = step * (i + 1) + (Math.random() * 3 - 1.5);
    const y = height / 2 + (Math.random() * 4 - 2);
    const angle = (Math.random() * 18 - 9) * (Math.PI / 180);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillText(code[i], 0, 0);
    ctx.restore();
  }
}

interface CaptchaFieldProps {
  id: string;
  code: string;
  value: string;
  onChange: (value: string) => void;
  onRefresh: () => void;
  invalid?: boolean;
  disabled?: boolean;
}

export const CaptchaField: React.FC<CaptchaFieldProps> = ({
  id,
  code,
  value,
  onChange,
  onRefresh,
  invalid,
  disabled,
}) => {
  // A callback ref (instead of useRef) makes the draw effect rerun the moment
  // the canvas actually mounts — the root cause of the old blank-captcha bug,
  // where the code was generated while the page still showed its loading state.
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isDark = useIsDarkMode();

  useEffect(() => {
    if (!canvasEl || !code) return;
    drawCaptcha(canvasEl, code, isDark);
  }, [canvasEl, code, isDark]);

  const handleRefresh = useCallback(() => {
    onRefresh();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [onRefresh]);

  const inputClasses = [
    'h-11 min-w-0 flex-1 rounded-xl border bg-white px-3.5 text-center font-mono text-sm font-semibold uppercase tracking-[0.3em] text-neutral-900 outline-none transition-colors',
    'placeholder:font-sans placeholder:normal-case placeholder:tracking-normal placeholder:text-neutral-400',
    'dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-600',
    disabled ? 'cursor-not-allowed opacity-60' : '',
    invalid
      ? 'border-rose-400 focus:border-rose-500 focus:ring-4 focus:ring-rose-500/10'
      : 'border-neutral-200 focus:border-neutral-900 focus:ring-4 focus:ring-neutral-900/5 dark:border-neutral-800 dark:focus:border-neutral-100 dark:focus:ring-white/10',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="space-y-2">
      <div className="flex min-h-5 items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
          图形验证码
        </label>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-neutral-500 transition-colors hover:text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900/20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-100 dark:focus-visible:ring-white/20"
        >
          <RefreshCw className="h-3 w-3" />
          换一张
        </button>
      </div>

      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={value}
          onChange={event =>
            onChange(
              event.target.value
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '')
                .slice(0, 4)
            )
          }
          placeholder="输入 4 位字符"
          maxLength={4}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          className={inputClasses}
        />

        <button
          type="button"
          onClick={handleRefresh}
          disabled={disabled}
          aria-label="图形验证码，点击换一张"
          title="点击换一张验证码"
          className="group relative h-11 w-[108px] shrink-0 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-100 focus:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/10 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-800 dark:bg-neutral-950 dark:focus-visible:ring-white/10"
        >
          <canvas ref={setCanvasEl} className="block h-full w-full" aria-hidden="true" />
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-neutral-900/0 opacity-0 transition-opacity group-hover:bg-neutral-900/10 group-hover:opacity-100 group-focus-visible:bg-neutral-900/10 group-focus-visible:opacity-100">
            <RefreshCw className="h-4 w-4 text-neutral-700 dark:text-neutral-200" />
          </span>
        </button>
      </div>
    </div>
  );
};
