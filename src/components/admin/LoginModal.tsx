import React, { useState, useEffect, useRef } from 'react';
import { Lock, X, ShieldCheck, KeyRound, User, RefreshCw, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { storage } from '../../services/storage';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess: () => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({
  isOpen,
  onClose,
  onLoginSuccess,
}) => {
  const [username, setUsername] = useState('Hecker');
  const [passcode, setPasscode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [captchaInput, setCaptchaInput] = useState('');
  const [currentCaptcha, setCurrentCaptcha] = useState('');
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const generateCaptcha = () => {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setCurrentCaptcha(code);
    setCaptchaInput('');
    setError(null);
  };

  useEffect(() => {
    if (isOpen) {
      generateCaptcha();
      setPasscode('');
      setError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !currentCaptcha) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    const isDark = document.documentElement.classList.contains('dark');
    ctx.fillStyle = isDark ? '#1e293b' : '#f1f5f9';
    ctx.fillRect(0, 0, width, height);

    // Random interference lines
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(Math.random() * width, Math.random() * height);
      ctx.lineTo(Math.random() * width, Math.random() * height);
      ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.4)' : 'rgba(100, 116, 139, 0.4)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // Dots
    for (let i = 0; i < 25; i++) {
      ctx.beginPath();
      ctx.arc(Math.random() * width, Math.random() * height, 1, 0, Math.PI * 2);
      ctx.fillStyle = isDark ? 'rgba(203, 213, 225, 0.5)' : 'rgba(71, 85, 105, 0.4)';
      ctx.fill();
    }

    const colors = isDark 
      ? ['#60a5fa', '#34d399', '#fbbf24', '#f87171']
      : ['#1d4ed8', '#047857', '#b45309', '#b91c1c'];

    ctx.font = 'bold 22px monospace';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < currentCaptcha.length; i++) {
      const char = currentCaptcha[i];
      const x = 16 + i * 20;
      const y = height / 2 + (Math.random() * 4 - 2);
      const angle = (Math.random() * 20 - 10) * (Math.PI / 180);

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillText(char, 0, 0);
      ctx.restore();
    }
  }, [currentCaptcha, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);


    // 1. Password minimum length requirement (>= 6 chars)
    if (passcode.length < 6) {
      setError('密码最低长度要求 6 位，请重新输入');
      return;
    }

    // 2. Captcha validation
    if (!captchaInput.trim()) {
      setError('请输入图形验证码');
      return;
    }

    if (captchaInput.trim().toUpperCase() !== currentCaptcha.toUpperCase()) {
      setError('验证码错误，请重新输入');
      generateCaptcha();
      return;
    }

    // 3. Verify Master Key against backend
    const result = await storage.verifyAndLogin(passcode);
    if (result.success) {
      setError(null);
      setPasscode('');
      onLoginSuccess();
      onClose();
    } else {
      setError(result.message || '访问密钥错误，认证失败');
      generateCaptcha();
    }
  };


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-900/50 backdrop-blur-xs">
      <div 
        className="w-full max-w-md bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl p-6 relative transition-all"
        onClick={e => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center text-neutral-900 dark:text-neutral-100">
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              Owner 认证登录
            </h3>
            <p className="text-xs text-neutral-500">
              个人知识库主理人专属管理控制台
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900/60 flex items-center gap-2 text-xs text-rose-700 dark:text-rose-300 animate-fade-in">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div>
            <label className="block font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              主理人账号
            </label>
            <div className="relative">
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="账号"
                className="w-full px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg text-sm text-neutral-900 dark:text-neutral-100 outline-none"
                required
              />
              <User className="w-4 h-4 text-neutral-400 absolute right-3 top-2.5" />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="font-medium text-neutral-700 dark:text-neutral-300">
                主理人访问密钥
              </label>
              <span className="text-[11px] text-neutral-400 font-mono">
                最低 6 位
              </span>
            </div>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={passcode}
                onChange={e => {
                  setPasscode(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="请输入访问密钥（至少 6 位）"
                className="w-full pl-3 pr-10 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg text-sm text-neutral-900 dark:text-neutral-100 outline-none font-mono"
                required
                minLength={6}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-2.5 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Captcha */}
          <div>
            <label className="block font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              安全验证码
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={captchaInput}
                onChange={e => {
                  setCaptchaInput(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="输入 4 位字符"
                maxLength={4}
                className="flex-1 px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg text-sm text-neutral-900 dark:text-neutral-100 font-mono uppercase tracking-widest text-center outline-none"
                required
              />

              <div
                onClick={generateCaptcha}
                className="cursor-pointer rounded-lg overflow-hidden border border-neutral-200 dark:border-neutral-800 shrink-0"
                title="点击刷新验证码"
              >
                <canvas
                  ref={canvasRef}
                  width={100}
                  height={38}
                  className="block"
                />
              </div>

              <button
                type="button"
                onClick={generateCaptcha}
                className="p-2 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 shrink-0"
                title="刷新验证码"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
          </div>


          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-medium text-white bg-neutral-900 dark:bg-neutral-100 dark:text-neutral-900 rounded-lg hover:bg-neutral-800 dark:hover:bg-neutral-200 transition-colors flex items-center gap-1.5 shadow-sm"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>验证并登录</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
