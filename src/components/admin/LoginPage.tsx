import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  FileText,
  HardDrive,
  KeyRound,
  Lock,
  Mail,
  Network,
  RefreshCw,
  RotateCcw,
  Shield,
  ShieldCheck,
  Sparkles,
  User,
} from 'lucide-react';
import { storage } from '../../services/storage';
import { apiClient } from '../../services/apiClient';
import { copyTextToClipboard } from '../../services/clipboard';
import { CaptchaField, useCaptcha } from '../common/CaptchaField';

interface LoginPageProps {
  onLoginSuccess: () => void;
  onCancel?: () => void;
}

type AuthMode = 'login' | 'reset' | 'setup';

type InvalidField =
  | 'login-username'
  | 'login-password'
  | 'setup-init-key'
  | 'setup-username'
  | 'setup-password'
  | 'setup-confirm'
  | 'reset-recovery'
  | 'reset-old-password'
  | 'reset-password'
  | 'reset-confirm'
  | 'captcha'
  | null;

interface AuthStatus {
  isInitialized: boolean;
  canInitialize: boolean;
}

const primaryButton =
  'flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 text-sm font-semibold text-white shadow-sm transition-all hover:bg-neutral-800 focus:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/20 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-45 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200 dark:focus-visible:ring-white/20';

const secondaryButton =
  'flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100 focus:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/10 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:focus-visible:ring-white/10';

interface AuthInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className' | 'id'> {
  id: string;
  label: string;
  icon?: React.ReactNode;
  labelRight?: React.ReactNode;
  trailing?: React.ReactNode;
  invalid?: boolean;
}

const AuthInput: React.FC<AuthInputProps> = ({
  id,
  label,
  icon,
  labelRight,
  trailing,
  invalid,
  ...inputProps
}) => (
  <div className="space-y-2">
    <div className="flex min-h-5 items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
        {label}
      </label>
      {labelRight}
    </div>
    <div className="relative">
      {icon && (
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500">
          {icon}
        </span>
      )}
      <input
        id={id}
        {...inputProps}
        aria-invalid={invalid || undefined}
        className={[
          'h-11 w-full rounded-xl border bg-white text-sm text-neutral-900 outline-none transition-colors',
          'placeholder:text-neutral-400 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-600',
          icon ? 'pl-10' : 'pl-3.5',
          trailing ? 'pr-11' : 'pr-3.5',
          inputProps.disabled ? 'cursor-not-allowed opacity-60' : '',
          invalid
            ? 'border-rose-400 focus:border-rose-500 focus:ring-4 focus:ring-rose-500/10'
            : 'border-neutral-200 focus:border-neutral-900 focus:ring-4 focus:ring-neutral-900/5 dark:border-neutral-800 dark:focus:border-neutral-100 dark:focus:ring-white/10',
        ]
          .filter(Boolean)
          .join(' ')}
      />
      {trailing && <div className="absolute right-2 top-1/2 -translate-y-1/2">{trailing}</div>}
    </div>
  </div>
);

const PasswordToggle: React.FC<{ visible: boolean; onToggle: () => void }> = ({
  visible,
  onToggle,
}) => (
  <button
    type="button"
    onClick={onToggle}
    aria-label={visible ? '隐藏密码' : '显示密码'}
    title={visible ? '隐藏密码' : '显示密码'}
    className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900/20 dark:hover:bg-neutral-800 dark:hover:text-neutral-200 dark:focus-visible:ring-white/20"
  >
    {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
  </button>
);

const AuthAlert: React.FC<{ tone: 'error' | 'success'; children: React.ReactNode }> = ({
  tone,
  children,
}) => (
  <div
    role={tone === 'error' ? 'alert' : 'status'}
    aria-live={tone === 'error' ? 'assertive' : 'polite'}
    className={`mb-5 flex items-start gap-2.5 rounded-xl border p-3.5 text-sm ${
      tone === 'error'
        ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300'
        : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
    }`}
  >
    {tone === 'error' ? (
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
    ) : (
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
    )}
    <span className="leading-relaxed">{children}</span>
  </div>
);

const BrandMark: React.FC<{ compact?: boolean }> = ({ compact }) => (
  <div className="flex items-center gap-3">
    <span
      className={`flex items-center justify-center rounded-xl font-mono font-bold ${
        compact
          ? 'h-9 w-9 bg-neutral-900 text-xs text-white dark:bg-white dark:text-neutral-900'
          : 'h-10 w-10 bg-white text-sm text-neutral-900'
      }`}
    >
      IF
    </span>
    <div>
      <p
        className={`font-semibold tracking-tight ${
          compact ? 'text-sm text-neutral-900 dark:text-neutral-100' : 'text-base text-white'
        }`}
      >
        InkFlow
      </p>
      <p
        className={`text-[10px] uppercase tracking-[0.2em] ${
          compact ? 'text-neutral-400 dark:text-neutral-500' : 'text-white/40'
        }`}
      >
        Knowledge Hub
      </p>
    </div>
  </div>
);

const AuthAside: React.FC<{ mode: AuthMode }> = ({ mode }) => {
  const content =
    mode === 'setup'
      ? {
          eyebrow: 'First run',
          title: '只需一步，建立你的知识空间。',
          description: '首次启动需要服务端配置的一次性初始化密钥，完成后初始化入口将永久关闭。',
          points: [
            { icon: <User className="h-4 w-4" />, text: '设置专属账号与访问密码' },
            { icon: <Shield className="h-4 w-4" />, text: '生成一次性应急恢复密钥' },
            { icon: <Sparkles className="h-4 w-4" />, text: '自动创建默认分类，即刻开始记录' },
          ],
          footer: '初始化密钥仅用于首次创建账号，不会保存在浏览器中。',
        }
      : mode === 'reset'
        ? {
            eyebrow: 'Recovery',
            title: '找回对知识库的访问权。',
            description: '使用一次性应急恢复密钥，或验证当前密码，为账号设置新的访问密码。',
            points: [
              { icon: <RotateCcw className="h-4 w-4" />, text: '重置后所有旧会话立即失效' },
              { icon: <KeyRound className="h-4 w-4" />, text: '系统自动签发新的恢复密钥' },
              { icon: <ShieldCheck className="h-4 w-4" />, text: '请妥善保管新的恢复密钥' },
            ],
            footer: '如果恢复密钥也已丢失，请通过服务器端维护流程处理。',
          }
        : {
            eyebrow: 'Welcome back',
            title: '把读过的、想过的，安放在这里。',
            description: 'InkFlow 是你的本地优先个人知识库，Markdown 是唯一事实来源。',
            points: [
              { icon: <HardDrive className="h-4 w-4" />, text: '本地优先，数据只存储在自己的服务器' },
              { icon: <FileText className="h-4 w-4" />, text: 'Markdown 写作、全文检索与版本管理' },
              { icon: <Network className="h-4 w-4" />, text: '分类、标签与知识图谱串联你的知识' },
            ],
            footer: '仅限知识库所有者访问 · 所有内容按你的可见性设置分享。',
          };

  return (
    <aside className="relative hidden flex-col justify-between overflow-hidden bg-neutral-950 px-10 py-12 text-white lg:flex xl:px-12">
      <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-sky-500/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-16 h-64 w-64 rounded-full bg-emerald-400/10 blur-3xl" />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }}
      />

      <div className="relative">
        <BrandMark />
        <p className="mt-12 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/35">
          {content.eyebrow}
        </p>
        <h2 className="mt-3 max-w-xs text-[26px] font-semibold leading-snug tracking-tight text-white">
          {content.title}
        </h2>
        <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/55">{content.description}</p>

        <ul className="mt-10 space-y-4">
          {content.points.map(point => (
            <li key={point.text} className="flex items-start gap-3 text-sm text-white/70">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/5 text-white/60 ring-1 ring-white/10">
                {point.icon}
              </span>
              <span className="leading-relaxed">{point.text}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative mt-10 flex items-center gap-2 text-[11px] leading-relaxed text-white/35">
        <Lock className="h-3 w-3 shrink-0" />
        {content.footer}
      </p>
    </aside>
  );
};

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess }) => {
  const [mode, setMode] = useState<AuthMode>('login');
  const [isCheckingInit, setIsCheckingInit] = useState(true);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);

  // Login inputs
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Setup inputs (First-run Initialization)
  const [setupUsername, setSetupUsername] = useState('');
  const [setupEmail, setSetupEmail] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupConfirmPassword, setSetupConfirmPassword] = useState('');
  const [setupInitKey, setSetupInitKey] = useState('');
  const [generatedRecoveryCode, setGeneratedRecoveryCode] = useState<string | null>(null);

  // Reset inputs
  const [resetRecoveryCode, setResetRecoveryCode] = useState('');
  const [resetOldPassword, setResetOldPassword] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetConfirmPassword, setResetConfirmPassword] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(true);
  const [newlyIssuedRecoveryCode, setNewlyIssuedRecoveryCode] = useState<string | null>(null);

  // Status feedback
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<InvalidField>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasCopiedCode, setHasCopiedCode] = useState(false);

  const copyTimerRef = useRef<number | null>(null);

  const {
    code: currentCaptcha,
    value: captchaInput,
    setValue: setCaptchaInput,
    refresh: refreshCaptcha,
  } = useCaptcha();

  const canInitialize = Boolean(authStatus?.canInitialize);

  // Whether the system has never been initialized and cannot be initialized
  // either (usually a missing INKFLOW_INIT_KEY). Surfacing this avoids a login
  // form that can only ever fail.
  const needsServerSetup =
    Boolean(authStatus) && authStatus?.isInitialized === false && !authStatus?.canInitialize;

  useEffect(() => {
    let cancelled = false;

    apiClient
      .getAuthStatus()
      .then(res => {
        if (cancelled || !res.data) return;
        setAuthStatus(res.data);
        if (res.data.isInitialized === false && res.data.canInitialize) {
          setMode('setup');
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setIsCheckingInit(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Every mode switch gets a fresh captcha. The CaptchaField draws through a
  // callback ref, so this is safe even before the canvas has mounted.
  useEffect(() => {
    refreshCaptcha();
  }, [mode, refreshCaptcha]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    []
  );

  const clearField = (field: InvalidField) => {
    if (invalidField === field) setInvalidField(null);
    if (errorMessage) setErrorMessage(null);
  };

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setErrorMessage(null);
    setSuccessMessage(null);
    setInvalidField(null);
    if (next === 'login') setNewlyIssuedRecoveryCode(null);
  };

  const isCaptchaWrong = () =>
    !captchaInput.trim() || captchaInput.trim().toUpperCase() !== currentCaptcha.toUpperCase();

  const rejectCaptcha = () => {
    setInvalidField('captcha');
    setErrorMessage('验证码不正确，已为你换一张');
    refreshCaptcha();
  };

  const copyToClipboard = async (text: string) => {
    const ok = await copyTextToClipboard(text);
    if (!ok) {
      setErrorMessage('复制失败，请手动选择密钥文本复制');
      return;
    }
    setHasCopiedCode(true);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setHasCopiedCode(false), 2000);
  };

  // Handle Login Submit
  const handleLoginSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isLoading || successMessage) return;

    setErrorMessage(null);
    setSuccessMessage(null);
    setInvalidField(null);

    const account = username.trim();
    if (!account) {
      setInvalidField('login-username');
      setErrorMessage('请输入账号');
      return;
    }

    if (password.length < 6) {
      setInvalidField('login-password');
      setErrorMessage('访问密码最低要求 6 位字符');
      return;
    }

    if (isCaptchaWrong()) {
      rejectCaptcha();
      return;
    }

    setIsLoading(true);

    try {
      const result = await storage.verifyAndLogin(password, account);
      if (result.success) {
        setSuccessMessage('登录成功，正在进入你的知识空间…');
        window.setTimeout(() => {
          onLoginSuccess();
        }, 400);
      } else {
        setErrorMessage(result.message || '账号或密码错误，请重试');
        refreshCaptcha();
      }
    } catch {
      setErrorMessage('网络异常，请稍后重试');
      refreshCaptcha();
    } finally {
      setIsLoading(false);
    }
  };

  // Handle First-Run Initialization Submit
  const handleSetupSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isLoading) return;

    setErrorMessage(null);
    setSuccessMessage(null);
    setInvalidField(null);

    if (!canInitialize) {
      setErrorMessage('服务端尚未配置初始化密钥，首次初始化不可用');
      return;
    }

    if (!setupInitKey.trim()) {
      setInvalidField('setup-init-key');
      setErrorMessage('请输入服务端配置的初始化密钥');
      return;
    }

    const account = setupUsername.trim();
    if (!account) {
      setInvalidField('setup-username');
      setErrorMessage('请输入账号名称');
      return;
    }

    if (setupPassword.length < 6) {
      setInvalidField('setup-password');
      setErrorMessage('访问密码最低要求 6 位字符');
      return;
    }

    if (setupPassword !== setupConfirmPassword) {
      setInvalidField('setup-confirm');
      setErrorMessage('两次输入的密码不一致，请核对');
      return;
    }

    if (isCaptchaWrong()) {
      rejectCaptcha();
      return;
    }

    setIsLoading(true);

    try {
      const res = await storage.initOwner({
        initKey: setupInitKey.trim(),
        username: account,
        password: setupPassword,
        email: setupEmail.trim() || undefined,
      });

      if (res.success && res.recoveryCode) {
        setGeneratedRecoveryCode(res.recoveryCode);
        setSuccessMessage('账号初始化成功，请妥善记录下方的一次性恢复密钥。');
      } else {
        setErrorMessage(res.message || '初始化失败，请重试');
        refreshCaptcha();
      }
    } catch {
      setErrorMessage('网络请求异常，初始化失败');
      refreshCaptcha();
    } finally {
      setIsLoading(false);
    }
  };

  // Handle Reset Password Submit
  const handleResetSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isLoading) return;

    setErrorMessage(null);
    setSuccessMessage(null);
    setInvalidField(null);

    if (resetNewPassword.length < 6) {
      setInvalidField('reset-password');
      setErrorMessage('新密码最低要求 6 位字符');
      return;
    }

    if (resetNewPassword !== resetConfirmPassword) {
      setInvalidField('reset-confirm');
      setErrorMessage('两次输入的新密码不一致，请核对');
      return;
    }

    if (useRecoveryCode && !resetRecoveryCode.trim()) {
      setInvalidField('reset-recovery');
      setErrorMessage('请输入应急恢复密钥');
      return;
    }

    if (!useRecoveryCode && !resetOldPassword.trim()) {
      setInvalidField('reset-old-password');
      setErrorMessage('请输入当前密码');
      return;
    }

    if (isCaptchaWrong()) {
      rejectCaptcha();
      return;
    }

    setIsLoading(true);

    try {
      const res = await storage.resetPassword({
        username: username.trim() || undefined,
        oldPassword: useRecoveryCode ? undefined : resetOldPassword,
        recoveryCode: useRecoveryCode ? resetRecoveryCode.trim() : undefined,
        newPassword: resetNewPassword,
      });

      if (res.success) {
        if (res.newRecoveryCode) {
          setNewlyIssuedRecoveryCode(res.newRecoveryCode);
        }
        setSuccessMessage(res.message || '密码重置成功，请使用新密码重新登录');
        setPassword(resetNewPassword);
      } else {
        setErrorMessage(res.message || '密码重置失败，请核对恢复密钥或原密码');
        refreshCaptcha();
      }
    } catch {
      setErrorMessage('重置请求失败，请稍后重试');
      refreshCaptcha();
    } finally {
      setIsLoading(false);
    }
  };

  if (isCheckingInit) {
    return (
      <div className="flex min-h-[calc(100vh-65px)] items-center justify-center bg-neutral-50 dark:bg-neutral-950">
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-neutral-200 bg-white text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-500">
            <RefreshCw className="h-5 w-5 animate-spin" />
          </div>
          <p className="text-xs text-neutral-400 dark:text-neutral-500">正在检查访问状态…</p>
        </div>
      </div>
    );
  }

  const headerCopy =
    mode === 'setup'
      ? {
          eyebrow: 'First run',
          title: '初始化账号',
          description: '首次使用 · 创建专属账号并生成安全凭据。',
        }
      : mode === 'reset'
        ? {
            eyebrow: 'Recovery',
            title: '重置密码',
            description: '验证身份后，为账号设置新的访问密码。',
          }
        : {
            eyebrow: 'Sign in',
            title: '欢迎回来',
            description: '登录以继续访问你的个人知识库。',
          };

  const forgotPasswordButton = (
    <button
      type="button"
      onClick={() => switchMode('reset')}
      className="rounded-md text-xs font-medium text-neutral-500 transition-colors hover:text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900/20 dark:text-neutral-400 dark:hover:text-neutral-100 dark:focus-visible:ring-white/20"
    >
      忘记密码？
    </button>
  );

  return (
    <div className="relative flex min-h-[calc(100vh-65px)] items-center justify-center overflow-hidden bg-neutral-50 px-4 py-8 sm:px-6 sm:py-12 dark:bg-neutral-950">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle at 12% 0%, rgba(14, 165, 233, 0.10), transparent 42%), radial-gradient(circle at 92% 100%, rgba(16, 185, 129, 0.07), transparent 38%)',
        }}
      />

      <div className="relative w-full max-w-5xl">
        <div className="overflow-hidden rounded-[28px] border border-neutral-200/80 bg-white shadow-[0_24px_80px_-40px_rgba(15,23,42,0.35)] dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-[0_24px_80px_-40px_rgba(0,0,0,0.85)] lg:grid lg:grid-cols-[1.04fr_0.96fr]">
          <AuthAside mode={mode} />

          <section className="px-6 py-8 sm:px-10 sm:py-10 lg:px-12 lg:py-12">
            <div className="mb-8 lg:hidden">
              <BrandMark compact />
            </div>

            <div className="mb-7">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-neutral-400 dark:text-neutral-500">
                {headerCopy.eyebrow}
              </p>
              <h1 className="mt-2 text-2xl font-bold tracking-tight text-neutral-900 sm:text-[28px] dark:text-neutral-100">
                {headerCopy.title}
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
                {headerCopy.description}
              </p>
            </div>

            {errorMessage && <AuthAlert tone="error">{errorMessage}</AuthAlert>}
            {successMessage && <AuthAlert tone="success">{successMessage}</AuthAlert>}

            {mode === 'setup' ? (
              generatedRecoveryCode ? (
                /* Setup Success & Display Recovery Code */
                <div className="space-y-5">
                  <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-5 dark:border-amber-900/60 dark:bg-amber-950/25">
                    <div className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
                      <Shield className="h-4 w-4" />
                      <span>一次性应急恢复密钥</span>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-amber-800/80 dark:text-amber-300/80">
                      请立即抄录或复制保存此密钥。遗忘密码时，它是找回账号的唯一凭据，系统仅展示这一次。
                    </p>
                    <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-amber-200/80 bg-white px-4 py-3 dark:border-amber-800 dark:bg-neutral-950">
                      <code className="min-w-0 truncate font-mono text-sm font-semibold tracking-wider text-neutral-900 dark:text-neutral-100">
                        {generatedRecoveryCode}
                      </code>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(generatedRecoveryCode)}
                        aria-label="复制恢复密钥"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900/20 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:focus-visible:ring-white/20"
                        title="复制到剪贴板"
                      >
                        {hasCopiedCode ? (
                          <Check className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  <button type="button" onClick={onLoginSuccess} className={primaryButton}>
                    <span>我已妥善保存，进入工作空间</span>
                  </button>
                </div>
              ) : (
                /* Setup Input Form */
                <form onSubmit={handleSetupSubmit} className="space-y-4">
                  {!canInitialize ? (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs leading-relaxed text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                      服务端尚未配置初始化密钥（环境变量{' '}
                      <code className="font-mono">INKFLOW_INIT_KEY</code>），首次初始化已被禁用。
                      请先在服务器上完成配置并重启服务。
                    </div>
                  ) : (
                    <div className="flex items-start gap-2.5 rounded-xl border border-sky-200 bg-sky-50 p-3.5 text-xs leading-relaxed text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-300">
                      <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        首次初始化需要验证服务端配置的一次性密钥。该密钥不会保存在浏览器中，初始化成功后入口将永久关闭。
                      </span>
                    </div>
                  )}

                  <AuthInput
                    id="setup-init-key"
                    label="初始化密钥"
                    icon={<KeyRound className="h-4 w-4" />}
                    type="password"
                    value={setupInitKey}
                    onChange={event => {
                      setSetupInitKey(event.target.value);
                      clearField('setup-init-key');
                    }}
                    placeholder="请输入服务端 INKFLOW_INIT_KEY 配置值"
                    required
                    autoComplete="off"
                    invalid={invalidField === 'setup-init-key'}
                  />

                  <AuthInput
                    id="setup-username"
                    label="账号名称"
                    icon={<User className="h-4 w-4" />}
                    type="text"
                    value={setupUsername}
                    onChange={event => {
                      setSetupUsername(event.target.value);
                      clearField('setup-username');
                    }}
                    placeholder="设置你的账号名称"
                    required
                    autoComplete="username"
                    invalid={invalidField === 'setup-username'}
                  />

                  <AuthInput
                    id="setup-email"
                    label="联系邮箱（选填）"
                    icon={<Mail className="h-4 w-4" />}
                    type="email"
                    value={setupEmail}
                    onChange={event => setSetupEmail(event.target.value)}
                    placeholder="your-email@example.com"
                    autoComplete="email"
                  />

                  <AuthInput
                    id="setup-password"
                    label="设置访问密码"
                    icon={<KeyRound className="h-4 w-4" />}
                    labelRight={
                      <span className="text-xs text-neutral-400 dark:text-neutral-500">最低 6 位</span>
                    }
                    type="password"
                    value={setupPassword}
                    onChange={event => {
                      setSetupPassword(event.target.value);
                      clearField('setup-password');
                    }}
                    placeholder="请输入访问密码"
                    required
                    minLength={6}
                    autoComplete="new-password"
                    invalid={invalidField === 'setup-password'}
                  />

                  <AuthInput
                    id="setup-confirm"
                    label="确认密码"
                    type="password"
                    value={setupConfirmPassword}
                    onChange={event => {
                      setSetupConfirmPassword(event.target.value);
                      clearField('setup-confirm');
                    }}
                    placeholder="再次输入以确认"
                    required
                    minLength={6}
                    autoComplete="new-password"
                    invalid={invalidField === 'setup-confirm'}
                  />

                  <CaptchaField
                    id="setup-captcha"
                    code={currentCaptcha}
                    value={captchaInput}
                    onChange={value => {
                      setCaptchaInput(value);
                      clearField('captcha');
                    }}
                    onRefresh={refreshCaptcha}
                    invalid={invalidField === 'captcha'}
                    disabled={isLoading}
                  />

                  <button
                    type="submit"
                    disabled={isLoading || !canInitialize}
                    className={`${primaryButton} mt-2`}
                  >
                    {isLoading ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin" />
                        <span>正在初始化…</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" />
                        <span>完成初始化并生成恢复密钥</span>
                      </>
                    )}
                  </button>
                </form>
              )
            ) : mode === 'login' ? (
              /* MODE: LOGIN FORM */
              <form onSubmit={handleLoginSubmit} className="space-y-4">
                {needsServerSetup && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs leading-relaxed text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      系统尚未初始化：服务端未配置初始化密钥（<code className="font-mono">INKFLOW_INIT_KEY</code>），
                      当前无法登录。请完成配置并重启服务。
                    </span>
                  </div>
                )}

                <AuthInput
                  id="login-username"
                  label="账号"
                  icon={<User className="h-4 w-4" />}
                  type="text"
                  value={username}
                  onChange={event => {
                    setUsername(event.target.value);
                    clearField('login-username');
                  }}
                  placeholder="请输入账号"
                  required
                  autoComplete="username"
                  autoFocus
                  invalid={invalidField === 'login-username'}
                />

                <AuthInput
                  id="login-password"
                  label="密码"
                  icon={<KeyRound className="h-4 w-4" />}
                  labelRight={forgotPasswordButton}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={event => {
                    setPassword(event.target.value);
                    clearField('login-password');
                  }}
                  placeholder="请输入访问密码"
                  required
                  minLength={6}
                  autoComplete="current-password"
                  invalid={invalidField === 'login-password'}
                  trailing={
                    <PasswordToggle
                      visible={showPassword}
                      onToggle={() => setShowPassword(visible => !visible)}
                    />
                  }
                />

                <CaptchaField
                  id="login-captcha"
                  code={currentCaptcha}
                  value={captchaInput}
                  onChange={value => {
                    setCaptchaInput(value);
                    clearField('captcha');
                  }}
                  onRefresh={refreshCaptcha}
                  invalid={invalidField === 'captcha'}
                  disabled={isLoading}
                />

                <button
                  type="submit"
                  disabled={isLoading || Boolean(successMessage)}
                  className={`${primaryButton} mt-2`}
                >
                  {isLoading ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      <span>正在登录…</span>
                    </>
                  ) : (
                    <>
                      <Lock className="h-4 w-4" />
                      <span>登录</span>
                    </>
                  )}
                </button>
              </form>
            ) : (
              /* MODE: RESET PASSWORD FORM */
              <form onSubmit={handleResetSubmit} className="space-y-4">
                {newlyIssuedRecoveryCode && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900/60 dark:bg-amber-950/25">
                    <span className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                      新的恢复密钥已生成
                    </span>
                    <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-200/80 bg-white px-3 py-2.5 dark:border-amber-800 dark:bg-neutral-950">
                      <code className="min-w-0 truncate font-mono text-sm font-semibold tracking-wider text-neutral-900 dark:text-neutral-100">
                        {newlyIssuedRecoveryCode}
                      </code>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(newlyIssuedRecoveryCode)}
                        aria-label="复制新的恢复密钥"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900/20 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:focus-visible:ring-white/20"
                        title="复制到剪贴板"
                      >
                        {hasCopiedCode ? (
                          <Check className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {/* Verification Method Toggle */}
                <div className="grid grid-cols-2 gap-1 rounded-xl border border-neutral-200 bg-neutral-100 p-1 dark:border-neutral-800 dark:bg-neutral-950">
                  <button
                    type="button"
                    onClick={() => {
                      setUseRecoveryCode(true);
                      clearField('reset-old-password');
                    }}
                    aria-pressed={useRecoveryCode}
                    className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                      useRecoveryCode
                        ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-800 dark:text-neutral-100'
                        : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200'
                    }`}
                  >
                    使用恢复密钥
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setUseRecoveryCode(false);
                      clearField('reset-recovery');
                    }}
                    aria-pressed={!useRecoveryCode}
                    className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                      !useRecoveryCode
                        ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-800 dark:text-neutral-100'
                        : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200'
                    }`}
                  >
                    使用原密码
                  </button>
                </div>

                {useRecoveryCode ? (
                  <AuthInput
                    id="reset-recovery"
                    label="一次性应急恢复密钥"
                    icon={<Sparkles className="h-4 w-4" />}
                    type="text"
                    value={resetRecoveryCode}
                    onChange={event => {
                      setResetRecoveryCode(event.target.value);
                      clearField('reset-recovery');
                    }}
                    placeholder="例如：INK-XXXX-XXXX-XXXX-XXXX"
                    required
                    autoComplete="off"
                    invalid={invalidField === 'reset-recovery'}
                  />
                ) : (
                  <AuthInput
                    id="reset-old-password"
                    label="当前密码"
                    icon={<Lock className="h-4 w-4" />}
                    type="password"
                    value={resetOldPassword}
                    onChange={event => {
                      setResetOldPassword(event.target.value);
                      clearField('reset-old-password');
                    }}
                    placeholder="请输入当前访问密码"
                    required
                    autoComplete="current-password"
                    invalid={invalidField === 'reset-old-password'}
                  />
                )}

                <AuthInput
                  id="reset-password"
                  label="新访问密码"
                  labelRight={
                    <span className="text-xs text-neutral-400 dark:text-neutral-500">最低 6 位</span>
                  }
                  type="password"
                  value={resetNewPassword}
                  onChange={event => {
                    setResetNewPassword(event.target.value);
                    clearField('reset-password');
                  }}
                  placeholder="设置新的访问密码"
                  required
                  minLength={6}
                  autoComplete="new-password"
                  invalid={invalidField === 'reset-password'}
                />

                <AuthInput
                  id="reset-confirm"
                  label="确认新密码"
                  type="password"
                  value={resetConfirmPassword}
                  onChange={event => {
                    setResetConfirmPassword(event.target.value);
                    clearField('reset-confirm');
                  }}
                  placeholder="再次输入新密码"
                  required
                  minLength={6}
                  autoComplete="new-password"
                  invalid={invalidField === 'reset-confirm'}
                />

                <CaptchaField
                  id="reset-captcha"
                  code={currentCaptcha}
                  value={captchaInput}
                  onChange={value => {
                    setCaptchaInput(value);
                    clearField('captcha');
                  }}
                  onRefresh={refreshCaptcha}
                  invalid={invalidField === 'captcha'}
                  disabled={isLoading}
                />

                <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => switchMode('login')}
                    className={`${secondaryButton} sm:w-40`}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    <span>返回登录</span>
                  </button>

                  <button type="submit" disabled={isLoading} className={`${primaryButton} sm:flex-1`}>
                    {isLoading ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin" />
                        <span>正在重置…</span>
                      </>
                    ) : (
                      <>
                        <RotateCcw className="h-4 w-4" />
                        <span>确认重置密码</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            )}

            <div className="mt-8 flex items-center justify-center gap-2 text-[11px] text-neutral-400 dark:text-neutral-500 lg:hidden">
              <BookOpen className="h-3 w-3" />
              <span>本地优先 · 你的数据只存储在自己的服务器</span>
            </div>
          </section>
        </div>

        <p className="mt-5 hidden items-center justify-center gap-2 text-[11px] text-neutral-400 dark:text-neutral-500 lg:flex">
          <BookOpen className="h-3 w-3" />
          本地优先 · 你的数据只存储在自己的服务器
        </p>
      </div>
    </div>
  );
};
