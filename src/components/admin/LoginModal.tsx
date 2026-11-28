import React, { useEffect, useState } from 'react';
import { AlertCircle, Eye, EyeOff, KeyRound, Lock, User, X } from 'lucide-react';
import { storage } from '../../services/storage';
import { CaptchaField, useCaptcha } from '../common/CaptchaField';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess: () => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({ isOpen, onClose, onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [passcode, setPasscode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { code, value: captchaInput, setValue: setCaptchaInput, refresh, validate } = useCaptcha();

  useEffect(() => {
    if (isOpen) {
      refresh();
      setPasscode('');
      setUsername('');
      setError(null);
    }
  }, [isOpen, refresh]);

  if (!isOpen) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const account = username.trim();
    if (!account) {
      setError('请输入账号');
      return;
    }

    if (passcode.length < 6) {
      setError('密码最低长度要求 6 位，请重新输入');
      return;
    }

    if (!captchaInput.trim()) {
      setError('请输入图形验证码');
      return;
    }

    if (!validate()) {
      setError('验证码不正确，已为你换一张');
      refresh();
      return;
    }

    const result = await storage.verifyAndLogin(passcode, account);
    if (result.success) {
      setError(null);
      setPasscode('');
      onLoginSuccess();
      onClose();
    } else {
      setError(result.message || '账号或密码错误，请重试');
      refresh();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50 p-4 backdrop-blur-xs">
      <div
        className="relative w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 shadow-2xl transition-all dark:border-neutral-800 dark:bg-neutral-900"
        onClick={event => event.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="关闭登录窗口"
          className="absolute right-4 top-4 rounded-lg p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100">
            <Lock className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              登录 InkFlow
            </h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">访问你的个人知识库</p>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-300"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="modal-username"
              className="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
            >
              账号
            </label>
            <div className="relative">
              <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              <input
                id="modal-username"
                type="text"
                value={username}
                onChange={event => {
                  setUsername(event.target.value);
                  if (error) setError(null);
                }}
                placeholder="请输入账号"
                className="h-11 w-full rounded-xl border border-neutral-200 bg-white pl-9 pr-3 text-sm text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-neutral-900 focus:ring-4 focus:ring-neutral-900/5 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-600 dark:focus:border-neutral-100 dark:focus:ring-white/10"
                autoComplete="username"
                required
                autoFocus
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="modal-password"
                className="text-sm font-medium text-neutral-800 dark:text-neutral-200"
              >
                密码
              </label>
              <span className="font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
                最低 6 位
              </span>
            </div>
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              <input
                id="modal-password"
                type={showPassword ? 'text' : 'password'}
                value={passcode}
                onChange={event => {
                  setPasscode(event.target.value);
                  if (error) setError(null);
                }}
                placeholder="请输入访问密码"
                className="h-11 w-full rounded-xl border border-neutral-200 bg-white pl-9 pr-11 text-sm text-neutral-900 outline-none transition-colors placeholder:text-neutral-400 focus:border-neutral-900 focus:ring-4 focus:ring-neutral-900/5 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-600 dark:focus:border-neutral-100 dark:focus:ring-white/10"
                autoComplete="current-password"
                minLength={6}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(visible => !visible)}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <CaptchaField
            id="modal-captcha"
            code={code}
            value={captchaInput}
            onChange={value => {
              setCaptchaInput(value);
              if (error) setError(null);
            }}
            onRefresh={refresh}
          />

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="h-11 rounded-xl px-4 text-sm font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-white"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex h-11 items-center gap-1.5 rounded-xl bg-neutral-900 px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              <Lock className="h-4 w-4" />
              <span>登录</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
