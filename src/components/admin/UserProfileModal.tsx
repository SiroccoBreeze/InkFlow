import React, { useState, useEffect } from 'react';
import {
  X,
  User,
  Shield,
  KeyRound,
  Check,
  Database,

  Lock,
  Mail,
  HardDrive,
  FileText,
  Clock,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
} from 'lucide-react';

import { UserSession } from '../../types';
import { apiClient } from '../../services/apiClient';
import { storage } from '../../services/storage';

interface UserProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: UserSession;
  onProfileUpdated: () => void;
  onNavigateToAdmin?: () => void;
}

export const UserProfileModal: React.FC<UserProfileModalProps> = ({
  isOpen,
  onClose,
  session,
  onProfileUpdated,
  onNavigateToAdmin,
}) => {
  const [activeTab, setActiveTab] = useState<'profile' | 'security' | 'stats'>('profile');

  // Profile form state
  const [username, setUsername] = useState('Hecker');
  const [email, setEmail] = useState('heckerchong@gmail.com');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileMessage, setProfileMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Password form state
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);


  // Stats state
  const [stats, setStats] = useState({
    docCount: 0,
    catCount: 0,
    tagCount: 0,
    attachmentCount: 0,
  });

  useEffect(() => {
    if (isOpen) {
      loadProfileAndStats();
    }
  }, [isOpen]);

  const loadProfileAndStats = async () => {
    try {
      const res = await apiClient.getProfile();
      if (res.data) {
        setUsername(res.data.username || 'Hecker');
        setEmail(res.data.email || 'heckerchong@gmail.com');
      }
    } catch {}

    const docs = storage.getDocs();
    const cats = storage.getCategories();
    const tags = storage.getAllTags();
    const attachments = storage.getAttachments();
    setStats({
      docCount: docs.length,
      catCount: cats.length,
      tagCount: tags.length,
      attachmentCount: attachments.length,
    });
  };

  if (!isOpen) return null;

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingProfile(true);
    setProfileMessage(null);

    try {
      const res = await apiClient.updateProfile({ username, email });
      if (res.data?.success) {
        setProfileMessage({ type: 'success', text: '主理人个人信息已成功更新' });
        onProfileUpdated();
      } else {
        setProfileMessage({ type: 'error', text: res.error?.message || '更新失败，请重试' });
      }
    } catch {
      setProfileMessage({ type: 'error', text: '网络异常，更新失败' });
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMessage(null);

    if (newPassword.length < 6) {
      setPasswordMessage({ type: 'error', text: '新密码长度至少需要 6 个字符' });
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordMessage({ type: 'error', text: '两次输入的新密码不一致' });
      return;
    }

    setIsChangingPassword(true);

    try {
      const res = await apiClient.changePassword(newPassword);

      if (res.data?.success) {
        setPasswordMessage({ type: 'success', text: '密码修改成功，后续请使用新密码登录' });
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        setPasswordMessage({ type: 'error', text: res.error?.message || '修改密码失败' });
      }
    } catch {
      setPasswordMessage({ type: 'error', text: '修改失败，请重试' });
    } finally {
      setIsChangingPassword(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-900/60 dark:bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-2xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-950/40">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-neutral-900 to-neutral-700 dark:from-neutral-100 dark:to-neutral-300 text-white dark:text-neutral-950 flex items-center justify-center font-bold text-base shadow-sm">
              {username ? username.charAt(0).toUpperCase() : 'H'}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-neutral-900 dark:text-neutral-100 text-base">
                  用户管理中心
                </h3>
                <span className="px-2 py-0.5 text-[10px] font-semibold bg-blue-100 text-blue-700 dark:bg-blue-950/80 dark:text-blue-300 rounded-full border border-blue-200 dark:border-blue-800">
                  知识库所有者 (Owner)
                </span>
              </div>
              <p className="text-xs text-neutral-500">
                管理主理人账号属性、安全认证密钥与本地资产
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center px-6 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/30 dark:bg-neutral-950/20 text-xs font-medium">
          <button
            onClick={() => setActiveTab('profile')}
            className={`py-3 px-3 flex items-center gap-2 border-b-2 transition-colors ${
              activeTab === 'profile'
                ? 'border-neutral-900 dark:border-neutral-100 text-neutral-900 dark:text-neutral-100 font-semibold'
                : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-200'
            }`}
          >
            <User className="w-3.5 h-3.5" />
            <span>个人资料</span>
          </button>
          <button
            onClick={() => setActiveTab('security')}
            className={`py-3 px-3 flex items-center gap-2 border-b-2 transition-colors ${
              activeTab === 'security'
                ? 'border-neutral-900 dark:border-neutral-100 text-neutral-900 dark:text-neutral-100 font-semibold'
                : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-200'
            }`}
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span>安全与密码</span>
          </button>
          <button
            onClick={() => setActiveTab('stats')}
            className={`py-3 px-3 flex items-center gap-2 border-b-2 transition-colors ${
              activeTab === 'stats'
                ? 'border-neutral-900 dark:border-neutral-100 text-neutral-900 dark:text-neutral-100 font-semibold'
                : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-200'
            }`}
          >
            <HardDrive className="w-3.5 h-3.5" />
            <span>知识库资产概览</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 text-xs">
          
          {/* TAB 1: PROFILE */}
          {activeTab === 'profile' && (
            <form onSubmit={handleSaveProfile} className="space-y-5">
              {profileMessage && (
                <div
                  className={`p-3 rounded-xl border flex items-center gap-2 ${
                    profileMessage.type === 'success'
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
                      : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300'
                  }`}
                >
                  {profileMessage.type === 'success' ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 shrink-0" />
                  )}
                  <span>{profileMessage.text}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="font-semibold text-neutral-700 dark:text-neutral-300 flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5 text-neutral-400" />
                    <span>主理人昵称 (Username)</span>
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    required
                    className="w-full px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 focus:border-neutral-900 dark:focus:border-neutral-100 transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="font-semibold text-neutral-700 dark:text-neutral-300 flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 text-neutral-400" />
                    <span>联系与应急邮箱 (Email)</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    className="w-full px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 focus:border-neutral-900 dark:focus:border-neutral-100 transition-colors"
                  />
                </div>
              </div>

              {/* Identity & Sovereignty Banner */}
              <div className="p-4 rounded-xl bg-neutral-50 dark:bg-neutral-950/60 border border-neutral-200/80 dark:border-neutral-800 space-y-2">
                <div className="flex items-center gap-2 font-semibold text-neutral-800 dark:text-neutral-200">
                  <Shield className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  <span>单主理人数据主权 (Local-First Authority)</span>
                </div>
                <p className="text-neutral-500 leading-relaxed">
                  当前环境为独立运行的个人知识中枢。文档正文保存在物理目录 <code className="px-1.5 py-0.5 rounded bg-neutral-200/60 dark:bg-neutral-800 font-mono text-[11px]">storage/documents/</code>，所有资源具有永久本地物理归属，免受任何云端第三方平台封禁或中断影响。
                </p>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={isSavingProfile}
                  className="px-5 py-2.5 bg-neutral-900 hover:bg-neutral-800 text-white dark:bg-neutral-100 dark:hover:bg-white dark:text-neutral-900 rounded-xl font-semibold transition-opacity flex items-center gap-2 shadow-sm"
                >
                  {isSavingProfile ? <span>正在保存...</span> : <span>保存资料修改</span>}
                </button>
              </div>
            </form>
          )}

          {/* TAB 2: SECURITY & PASSWORD */}
          {activeTab === 'security' && (
            <div className="space-y-6">
              {passwordMessage && (
                <div
                  className={`p-3 rounded-xl border flex items-center gap-2 ${
                    passwordMessage.type === 'success'
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
                      : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300'
                  }`}
                >
                  {passwordMessage.type === 'success' ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 shrink-0" />
                  )}
                  <span>{passwordMessage.text}</span>
                </div>
              )}

              {/* Password update form */}
              <form onSubmit={handleChangePassword} className="space-y-4">
                <h4 className="font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-neutral-500" />
                  <span>修改工作台访问密码</span>
                </h4>

                <div className="space-y-1.5">
                  <label className="font-medium text-neutral-600 dark:text-neutral-400">
                    当前原密码（若是首次重置，可留空直接使用应急恢复码）
                  </label>
                  <input
                    type="password"
                    value={oldPassword}
                    onChange={e => setOldPassword(e.target.value)}
                    placeholder="输入当前密码"
                    className="w-full px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 font-mono"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="font-medium text-neutral-600 dark:text-neutral-400">
                      新访问密码 (至少 6 位)
                    </label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={e => setNewPassword(e.target.value)}
                      placeholder="至少 6 位字符"
                      required
                      minLength={6}
                      className="w-full px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 font-mono"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="font-medium text-neutral-600 dark:text-neutral-400">
                      确认新密码
                    </label>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={e => setConfirmPassword(e.target.value)}
                      placeholder="再次输入新密码"
                      required
                      minLength={6}
                      className="w-full px-3.5 py-2.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-xl outline-none text-neutral-900 dark:text-neutral-100 font-mono"
                    />
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={isChangingPassword}
                    className="px-5 py-2.5 bg-neutral-900 hover:bg-neutral-800 text-white dark:bg-neutral-100 dark:hover:bg-white dark:text-neutral-900 rounded-xl font-semibold transition-opacity flex items-center gap-2 shadow-sm"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>{isChangingPassword ? '正在更新密码...' : '立即确认修改密码'}</span>
                  </button>
                </div>
              </form>

              {/* Security Advisory Card */}
              <div className="p-4 rounded-xl border border-blue-200 dark:border-blue-900/60 bg-blue-50/50 dark:bg-blue-950/20 space-y-2">
                <div className="flex items-center gap-2 font-bold text-blue-900 dark:text-blue-200 text-xs">
                  <ShieldCheck className="w-4 h-4 text-blue-500" />
                  <span>主理人权限与安全凭据管理</span>
                </div>
                <p className="text-[11px] text-blue-700/90 dark:text-blue-300/80 leading-relaxed">
                  InkFlow 使用 salted scrypt 与一次性应急恢复密钥机制保护系统。密码变更后，所有现有会话将被撤销。重置密码后系统将自动签发新的单次应急密钥。
                </p>
              </div>

            </div>
          )}

          {/* TAB 3: STATS & OVERVIEW */}
          {activeTab === 'stats' && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 text-center space-y-1">
                  <FileText className="w-4 h-4 mx-auto text-blue-500" />
                  <div className="text-xl font-bold text-neutral-900 dark:text-neutral-100 font-mono">
                    {stats.docCount}
                  </div>
                  <div className="text-[11px] text-neutral-500">文档总数 (SSOT)</div>
                </div>

                <div className="p-3.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 text-center space-y-1">
                  <Database className="w-4 h-4 mx-auto text-emerald-500" />
                  <div className="text-xl font-bold text-neutral-900 dark:text-neutral-100 font-mono">
                    {stats.catCount}
                  </div>
                  <div className="text-[11px] text-neutral-500">知识领域分类</div>
                </div>

                <div className="p-3.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 text-center space-y-1">
                  <HardDrive className="w-4 h-4 mx-auto text-purple-500" />
                  <div className="text-xl font-bold text-neutral-900 dark:text-neutral-100 font-mono">
                    {stats.tagCount}
                  </div>
                  <div className="text-[11px] text-neutral-500">知识索引标签</div>
                </div>

                <div className="p-3.5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 text-center space-y-1">
                  <Clock className="w-4 h-4 mx-auto text-amber-500" />
                  <div className="text-xl font-bold text-neutral-900 dark:text-neutral-100 font-mono">
                    {stats.attachmentCount}
                  </div>
                  <div className="text-[11px] text-neutral-500">媒体与附件文件</div>
                </div>
              </div>

              <div className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 space-y-3">
                <h4 className="font-bold text-neutral-900 dark:text-neutral-100">
                  快捷管理通道
                </h4>
                <div className="flex flex-wrap gap-2.5">
                  {onNavigateToAdmin && (
                    <button
                      onClick={() => {
                        onClose();
                        onNavigateToAdmin();
                      }}
                      className="px-4 py-2 bg-neutral-900 hover:bg-neutral-800 text-white dark:bg-neutral-100 dark:hover:bg-white dark:text-neutral-900 rounded-xl font-semibold transition-colors flex items-center gap-1.5"
                    >
                      <HardDrive className="w-3.5 h-3.5" />
                      <span>打开个人内容管理台</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-950/40 flex items-center justify-between text-xs text-neutral-500">
          <span>InkFlow Personal Hub · v1.2</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300 transition-colors"
          >
            关闭窗口
          </button>
        </div>

      </div>
    </div>
  );
};
