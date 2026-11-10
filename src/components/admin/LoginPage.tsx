import React, { useState, useEffect, useRef } from 'react';
import {
  Lock,
  User,
  KeyRound,
  ShieldCheck,
  RefreshCw,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  RotateCcw,
  Copy,
  Check,
  Mail,
  Shield,
} from 'lucide-react';
import { storage } from '../../services/storage';
import { apiClient } from '../../services/apiClient';

interface LoginPageProps {
  onLoginSuccess: () => void;
  onCancel?: () => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess }) => {
  const [mode, setMode] = useState<'login' | 'reset' | 'setup'>('login');
  const [isCheckingInit, setIsCheckingInit] = useState(true);

  // Login inputs
  const [username, setUsername] = useState('owner');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [captchaInput, setCaptchaInput] = useState('');
  const [currentCaptcha, setCurrentCaptcha] = useState('');

  // Setup inputs (First-run Initialization)
  const [setupUsername, setSetupUsername] = useState('owner');
  const [setupEmail, setSetupEmail] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupConfirmPassword, setSetupConfirmPassword] = useState('');
  const [generatedRecoveryCode, setGeneratedRecoveryCode] = useState<string | null>(null);
  const [hasCopiedCode, setHasCopiedCode] = useState(false);

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
  const [isLoading, setIsLoading] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Check whether system is initialized on mount
  useEffect(() => {
    apiClient.getAuthStatus().then(res => {
      if (res.data && res.data.isInitialized === false) {
        setMode('setup');
      }
    }).catch(() => {}).finally(() => {
      setIsCheckingInit(false);
    });
  }, []);

  // Generate a 4-character alphanumeric captcha
  const generateCaptcha = () => {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setCurrentCaptcha(code);
    setCaptchaInput('');
    setErrorMessage(null);
  };

  useEffect(() => {
    generateCaptcha();
  }, [mode]);

  // Render stylized captcha on HTML5 canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !currentCaptcha) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    const isDark = document.documentElement.classList.contains('dark');
    ctx.fillStyle = isDark ? '#171717' : '#f8fafc';
    ctx.fillRect(0, 0, width, height);

    // Decorative wave background
    ctx.beginPath();
    ctx.moveTo(0, height * 0.5);
    ctx.bezierCurveTo(width * 0.3, height * 0.2, width * 0.7, height * 0.8, width, height * 0.4);
    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Interference lines
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(Math.random() * width, Math.random() * height);
      ctx.lineTo(Math.random() * width, Math.random() * height);
      ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.4)' : 'rgba(100, 116, 139, 0.4)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // Random noise dots
    for (let i = 0; i < 24; i++) {
      ctx.beginPath();
      ctx.arc(Math.random() * width, Math.random() * height, 1, 0, Math.PI * 2);
      ctx.fillStyle = isDark ? 'rgba(203, 213, 225, 0.5)' : 'rgba(71, 85, 105, 0.4)';
      ctx.fill();
    }

    const colors = isDark
      ? ['#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa']
      : ['#0284c7', '#059669', '#d97706', '#e11d48', '#7c3aed'];

    ctx.font = 'bold 22px "JetBrains Mono", Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < currentCaptcha.length; i++) {
      const char = currentCaptcha[i];
      const x = 16 + i * 23;
      const y = height / 2 + (Math.random() * 4 - 2);
      const angle = (Math.random() * 22 - 11) * (Math.PI / 180);

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillText(char, 0, 0);
      ctx.restore();
    }
  }, [currentCaptcha, mode]);

  // Handle Login Submit
  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (password.length < 6) {
      setErrorMessage('访问密码最低要求 6 位字符');
      return;
    }

    if (!captchaInput.trim() || captchaInput.trim().toUpperCase() !== currentCaptcha.toUpperCase()) {
      setErrorMessage('验证码不正确，请重新输入');
      generateCaptcha();
      return;
    }

    setIsLoading(true);

    try {
      const result = await storage.verifyAndLogin(password);
      if (result.success) {
        setSuccessMessage('主理人身份核验成功，正在进入工作空间...');
        setTimeout(() => {
          onLoginSuccess();
        }, 400);
      } else {
        setErrorMessage(result.message || '访问密钥错误，认证失败');
        generateCaptcha();
      }
    } catch {
      setErrorMessage('网络异常或认证失败，请重试');
      generateCaptcha();
    } finally {
      setIsLoading(false);
    }
  };

  // Handle First-Run Initialization Submit
  const handleSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (setupPassword.length < 6) {
      setErrorMessage('主理人密码最低要求 6 位');
      return;
    }

    if (setupPassword !== setupConfirmPassword) {
      setErrorMessage('两次输入的密码不一致，请核对');
      return;
    }

    if (!captchaInput.trim() || captchaInput.trim().toUpperCase() !== currentCaptcha.toUpperCase()) {
      setErrorMessage('验证码不正确，请重新输入');
      generateCaptcha();
      return;
    }

    setIsLoading(true);

    try {
      const res = await storage.initOwner({
        username: setupUsername,
        password: setupPassword,
        email: setupEmail || undefined,
      });

      if (res.success && res.recoveryCode) {
        setGeneratedRecoveryCode(res.recoveryCode);
        setSuccessMessage('主理人账号初始化成功！请妥善记录下方应急恢复密钥。');
      } else {
        setErrorMessage(res.message || '初始化失败，请重试');
        generateCaptcha();
      }
    } catch {
      setErrorMessage('网络请求异常，初始化失败');
      generateCaptcha();
    } finally {
      setIsLoading(false);
    }
  };

  // Handle Reset Password Submit
  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (resetNewPassword.length < 6) {
      setErrorMessage('新密码最低要求 6 位字符');
      return;
    }

    if (resetNewPassword !== resetConfirmPassword) {
      setErrorMessage('两次输入的新密码不一致，请核对');
      return;
    }

    if (useRecoveryCode && !resetRecoveryCode.trim()) {
      setErrorMessage('请输入应急恢复密钥');
      return;
    }

    if (!useRecoveryCode && !resetOldPassword.trim()) {
      setErrorMessage('请输入当前原密码');
      return;
    }

    if (!captchaInput.trim() || captchaInput.trim().toUpperCase() !== currentCaptcha.toUpperCase()) {
      setErrorMessage('安全验证码错误，请重新输入');
      generateCaptcha();
      return;
    }

    setIsLoading(true);

    try {
      const res = await storage.resetPassword({
        username,
        oldPassword: useRecoveryCode ? undefined : resetOldPassword,
        recoveryCode: useRecoveryCode ? resetRecoveryCode.trim() : undefined,
        newPassword: resetNewPassword,
      });

      if (res.success) {
        if (res.newRecoveryCode) {
          setNewlyIssuedRecoveryCode(res.newRecoveryCode);
        }
        setSuccessMessage(res.message || '密码重置成功！请妥善保存新生成的应急恢复密钥');
        setPassword(resetNewPassword);
      } else {
        setErrorMessage(res.message || '密码重置失败，请核对恢复密钥或原密码');
        generateCaptcha();
      }
    } catch {
      setErrorMessage('重置请求失败，请稍后重试');
      generateCaptcha();
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setHasCopiedCode(true);
    setTimeout(() => setHasCopiedCode(false), 2000);
  };

  if (isCheckingInit) {
    return (
      <div className="min-h-[calc(100vh-65px)] flex items-center justify-center">
        <RefreshCw className="w-6 h-6 animate-spin text-neutral-400" />
      </div>
    );
  }

  return (
    <div className="relative min-h-[calc(100vh-65px)] flex items-center justify-center px-4 py-12 overflow-hidden select-none">
      
      {/* Ambient background decoration */}
      <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
        <div className="w-[500px] h-[500px] bg-gradient-to-tr from-neutral-200/40 via-blue-100/30 to-purple-100/30 dark:from-neutral-900/60 dark:via-blue-950/20 dark:to-purple-950/20 rounded-full blur-3xl opacity-70 animate-pulse transition-all" />
      </div>

      {/* Main Glassmorphism Card */}
      <div className="relative w-full max-w-[440px] bg-white/90 dark:bg-neutral-900/90 backdrop-blur-xl border border-neutral-200/80 dark:border-neutral-800 rounded-3xl shadow-2xl p-7 sm:p-9 transition-all">
        
        {/* Brand Header */}
        <div className="text-center space-y-3 mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 shadow-md">
            {mode === 'setup' ? <Sparkles className="w-7 h-7 text-amber-400" /> : <Lock className="w-7 h-7" />}
          </div>
          
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
              {mode === 'setup'
                ? '初始化主理人账号'
                : mode === 'login'
                ? 'InkFlow Knowledge Hub'
                : '重置主理人密码'}
            </h1>
            <p className="text-xs text-neutral-500 mt-1 max-w-xs mx-auto leading-relaxed">
              {mode === 'setup'
                ? '首次启动部署 · 设置专属主理人密码与应急安全密钥'
                : mode === 'login'
                ? '个人第二大脑与知识资产库 · 请先验证主理人身份'
                : '使用一次性应急恢复密钥或原密码重设主理人访问密钥'}
            </p>
          </div>
        </div>

        {/* Feedback Alerts */}
        {errorMessage && (
          <div className="mb-5 p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 flex items-center gap-2.5 text-xs text-rose-700 dark:text-rose-300 animate-fade-in">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {successMessage && (
          <div className="mb-5 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 flex items-center gap-2.5 text-xs text-emerald-700 dark:text-emerald-300 animate-fade-in">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* MODE: SETUP (FIRST RUN) */}
        {mode === 'setup' ? (
          generatedRecoveryCode ? (
            /* Setup Success & Display Recovery Code */
            <div className="space-y-5 text-xs">
              <div className="p-4 rounded-2xl bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 space-y-3">
                <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300 font-semibold text-sm">
                  <Shield className="w-4 h-4" />
                  <span>一次性应急恢复密钥</span>
                </div>
                <p className="text-neutral-600 dark:text-neutral-400 text-[11px] leading-relaxed">
                  请务必立即妥善抄录或复制保存此密钥！当遗忘访问密码时，此密钥是找回主理人身份的唯一凭据，且系统仅展示此一次。
                </p>
                <div className="flex items-center justify-between p-3 rounded-xl bg-white dark:bg-neutral-950 border border-amber-200/80 dark:border-amber-800 font-mono text-sm tracking-wider font-bold text-neutral-900 dark:text-neutral-100">
                  <span>{generatedRecoveryCode}</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(generatedRecoveryCode)}
                    className="p-1.5 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
                    title="复制到剪贴板"
                  >
                    {hasCopiedCode ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={onLoginSuccess}
                className="w-full py-3 px-4 rounded-xl font-semibold text-white bg-neutral-900 dark:bg-neutral-100 dark:text-neutral-900 hover:opacity-90 active:scale-[0.99] transition-all flex items-center justify-center gap-2 shadow-lg"
              >
                <span>我已妥善保存，进入工作空间</span>
              </button>
            </div>
          ) : (
            /* Setup Input Form */
            <form onSubmit={handleSetupSubmit} className="space-y-4 text-xs">
              <div className="space-y-1.5">
                <label className="font-semibold text-neutral-700 dark:text-neutral-300 flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5 text-neutral-400" />
                  主理人账号名称
                </label>
                <input
                  type="text"
                  value={setupUsername}
                  onChange={e => setSetupUsername(e.target.value)}
                  placeholder="默认: owner"
                  required
                  className="w-full px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 focus:border-neutral-900 dark:focus:border-neutral-100 transition-colors"
                />
              </div>

              <div className="space-y-1.5">
                <label className="font-semibold text-neutral-700 dark:text-neutral-300 flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5 text-neutral-400" />
                  联系邮箱（选填）
                </label>
                <input
                  type="email"
                  value={setupEmail}
                  onChange={e => setSetupEmail(e.target.value)}
                  placeholder="your-email@example.com"
                  className="w-full px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 focus:border-neutral-900 dark:focus:border-neutral-100 transition-colors"
                />
              </div>

              <div className="space-y-1.5">
                <label className="font-semibold text-neutral-700 dark:text-neutral-300 flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-neutral-400" />
                    设置主理人密码
                  </span>
                  <span className="text-[11px] text-neutral-400">最低 6 位</span>
                </label>
                <input
                  type="password"
                  value={setupPassword}
                  onChange={e => setSetupPassword(e.target.value)}
                  placeholder="请输入主理人安全访问密码"
                  required
                  minLength={6}
                  className="w-full px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <label className="font-semibold text-neutral-700 dark:text-neutral-300">
                  确认密码
                </label>
                <input
                  type="password"
                  value={setupConfirmPassword}
                  onChange={e => setSetupConfirmPassword(e.target.value)}
                  placeholder="再次输入以确认"
                  required
                  minLength={6}
                  className="w-full px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 font-mono"
                />
              </div>

              {/* Graphic Captcha */}
              <div className="space-y-1.5">
                <label className="font-semibold text-neutral-700 dark:text-neutral-300 flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-neutral-400" />
                    图形验证码
                  </span>
                  <span className="text-[11px] text-neutral-400 font-normal">点击图片可刷新</span>
                </label>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={captchaInput}
                    onChange={e => {
                      setCaptchaInput(e.target.value);
                      if (errorMessage) setErrorMessage(null);
                    }}
                    placeholder="输入 4 位字符"
                    maxLength={4}
                    required
                    className="flex-1 px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 font-mono uppercase tracking-widest text-center"
                  />
                  <div
                    onClick={generateCaptcha}
                    className="relative cursor-pointer rounded-xl overflow-hidden border border-neutral-200 dark:border-neutral-800 shrink-0"
                  >
                    <canvas ref={canvasRef} width={110} height={42} className="block" />
                  </div>
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full mt-2 py-3 px-4 rounded-xl font-semibold text-white bg-neutral-900 dark:bg-neutral-100 dark:text-neutral-900 hover:opacity-90 active:scale-[0.99] transition-all flex items-center justify-center gap-2 shadow-lg"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>正在初始化系统...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    <span>完成初始化并生成安全凭据</span>
                  </>
                )}
              </button>
            </form>
          )
        ) : mode === 'login' ? (
          /* MODE: LOGIN FORM */
          <form onSubmit={handleLoginSubmit} className="space-y-4 text-xs">
            
            {/* Username Input */}
            <div className="space-y-1.5">
              <label className="font-semibold text-neutral-700 dark:text-neutral-300 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5 text-neutral-400" />
                  主理人账号
                </span>
                <span className="text-[11px] text-neutral-400 font-normal">默认: owner</span>
              </label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="请输入账号名称"
                required
                className="w-full px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 focus:border-neutral-900 dark:focus:border-neutral-100 transition-colors"
              />
            </div>

            {/* Password Input */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="font-semibold text-neutral-700 dark:text-neutral-300 flex items-center gap-1.5">
                  <KeyRound className="w-3.5 h-3.5 text-neutral-400" />
                  <span>访问密码</span>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setMode('reset');
                    setErrorMessage(null);
                    setSuccessMessage(null);
                    setNewlyIssuedRecoveryCode(null);
                  }}
                  className="text-[11px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-200 transition-colors hover:underline"
                >
                  忘记密码？
                </button>
              </div>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => {
                    setPassword(e.target.value);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  placeholder="请输入主理人访问密码"
                  required
                  minLength={6}
                  className="w-full pl-3.5 pr-10 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 focus:border-neutral-900 dark:focus:border-neutral-100 transition-colors font-mono tracking-wider"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-2.5 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 transition-colors"
                  title={showPassword ? '隐藏密码' : '显示密码'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Graphic Captcha */}
            <div className="space-y-1.5">
              <label className="font-semibold text-neutral-700 dark:text-neutral-300 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-neutral-400" />
                  图形验证码
                </span>
                <span className="text-[11px] text-neutral-400 font-normal">点击图片可刷新</span>
              </label>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={captchaInput}
                  onChange={e => {
                    setCaptchaInput(e.target.value);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  placeholder="输入 4 位字符"
                  maxLength={4}
                  required
                  className="flex-1 px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 font-mono uppercase tracking-widest text-center focus:border-neutral-900 dark:focus:border-neutral-100 transition-colors"
                />

                <div
                  onClick={generateCaptcha}
                  className="relative cursor-pointer rounded-xl overflow-hidden border border-neutral-200 dark:border-neutral-800 select-none group shrink-0 shadow-sm"
                  title="点击刷新验证码"
                >
                  <canvas ref={canvasRef} width={110} height={42} className="block" />
                  <div className="absolute inset-0 bg-black/10 dark:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-neutral-700 dark:text-neutral-200">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={generateCaptcha}
                  className="p-2.5 rounded-xl border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors shrink-0"
                  title="刷新验证码"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full mt-2 py-3 px-4 rounded-xl font-semibold text-white bg-neutral-900 dark:bg-neutral-100 dark:text-neutral-900 hover:opacity-90 active:scale-[0.99] transition-all flex items-center justify-center gap-2 shadow-lg"
            >
              {isLoading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>正在验证身份...</span>
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4" />
                  <span>验证并解锁个人知识库</span>
                </>
              )}
            </button>

          </form>
        ) : (
          /* MODE: RESET PASSWORD FORM */
          <form onSubmit={handleResetSubmit} className="space-y-4 text-xs animate-fade-in">
            
            {/* If a new recovery code was issued after reset */}
            {newlyIssuedRecoveryCode && (
              <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 space-y-2">
                <span className="font-semibold text-amber-800 dark:text-amber-300">
                  新应急恢复密钥已生成：
                </span>
                <div className="flex items-center justify-between font-mono bg-white dark:bg-neutral-950 p-2 rounded-lg border border-amber-200 dark:border-amber-800">
                  <span>{newlyIssuedRecoveryCode}</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(newlyIssuedRecoveryCode)}
                    className="p-1 text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                  >
                    {hasCopiedCode ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
            )}

            {/* Verification Method Toggle */}
            <div className="flex items-center gap-2 p-1 bg-neutral-100 dark:bg-neutral-950 rounded-xl border border-neutral-200 dark:border-neutral-800">
              <button
                type="button"
                onClick={() => setUseRecoveryCode(true)}
                className={`flex-1 py-1.5 rounded-lg font-medium transition-colors ${
                  useRecoveryCode
                    ? 'bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 shadow-sm'
                    : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-300'
                }`}
              >
                使用一次性恢复密钥
              </button>
              <button
                type="button"
                onClick={() => setUseRecoveryCode(false)}
                className={`flex-1 py-1.5 rounded-lg font-medium transition-colors ${
                  !useRecoveryCode
                    ? 'bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 shadow-sm'
                    : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-300'
                }`}
              >
                验证原密码修改
              </button>
            </div>

            {useRecoveryCode ? (
              <div className="space-y-1.5">
                <label className="font-semibold text-neutral-700 dark:text-neutral-300 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                  <span>一次性应急恢复密钥</span>
                </label>
                <input
                  type="text"
                  value={resetRecoveryCode}
                  onChange={e => setResetRecoveryCode(e.target.value)}
                  placeholder="例如: INK-XXXX-XXXX-XXXX-XXXX"
                  required
                  className="w-full px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 font-mono tracking-wider"
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <label className="font-semibold text-neutral-700 dark:text-neutral-300 flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-neutral-400" />
                  <span>当前原密码</span>
                </label>
                <input
                  type="password"
                  value={resetOldPassword}
                  onChange={e => setResetOldPassword(e.target.value)}
                  placeholder="请输入当前原密码"
                  required
                  className="w-full px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 font-mono"
                />
              </div>
            )}

            {/* New Password */}
            <div className="space-y-1.5">
              <label className="font-semibold text-neutral-700 dark:text-neutral-300 flex items-center justify-between">
                <span>新访问密码</span>
                <span className="text-[11px] text-neutral-400 font-normal">最低 6 位</span>
              </label>
              <input
                type="password"
                value={resetNewPassword}
                onChange={e => setResetNewPassword(e.target.value)}
                placeholder="设置新密码（至少 6 位）"
                required
                minLength={6}
                className="w-full px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 font-mono"
              />
            </div>

            {/* Confirm New Password */}
            <div className="space-y-1.5">
              <label className="font-semibold text-neutral-700 dark:text-neutral-300">
                再次确认新密码
              </label>
              <input
                type="password"
                value={resetConfirmPassword}
                onChange={e => setResetConfirmPassword(e.target.value)}
                placeholder="再次输入新密码"
                required
                minLength={6}
                className="w-full px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 font-mono"
              />
            </div>

            {/* Graphic Captcha */}
            <div className="space-y-1.5">
              <label className="font-semibold text-neutral-700 dark:text-neutral-300">
                安全验证码
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={captchaInput}
                  onChange={e => setCaptchaInput(e.target.value)}
                  placeholder="输入 4 位字符"
                  maxLength={4}
                  required
                  className="flex-1 px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 font-mono uppercase tracking-widest text-center"
                />
                <div
                  onClick={generateCaptcha}
                  className="relative cursor-pointer rounded-xl overflow-hidden border border-neutral-200 dark:border-neutral-800 shrink-0"
                >
                  <canvas ref={canvasRef} width={110} height={42} className="block" />
                </div>
              </div>
            </div>

            {/* Buttons */}
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setErrorMessage(null);
                  setSuccessMessage(null);
                  setNewlyIssuedRecoveryCode(null);
                }}
                className="py-2.5 px-4 rounded-xl border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300 font-medium transition-colors"
              >
                返回登录
              </button>

              <button
                type="submit"
                disabled={isLoading}
                className="flex-1 py-2.5 px-4 rounded-xl font-semibold text-white bg-neutral-900 dark:bg-neutral-100 dark:text-neutral-900 hover:opacity-90 transition-opacity flex items-center justify-center gap-1.5 shadow-md"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{isLoading ? '正在重置...' : '确认重置密码'}</span>
              </button>
            </div>

          </form>
        )}

      </div>
    </div>
  );
};
