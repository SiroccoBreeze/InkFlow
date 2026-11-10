import React, { useState, useRef, useEffect } from 'react';
import {
  Search,
  Sun,
  Moon,
  User,
  LogOut,
  Share2,
  Radio,
  Settings,
  ChevronDown,
  LayoutDashboard,
  Shield,
  Layers,
  BookOpen,
} from 'lucide-react';
import { UserSession } from '../types';

interface HeaderProps {
  currentTab: 'portal' | 'graph' | 'forum' | 'categories' | 'tags' | 'architecture' | 'admin' | 'login';
  onSelectTab: (tab: 'portal' | 'graph' | 'forum' | 'categories' | 'tags' | 'architecture' | 'admin' | 'login') => void;
  onOpenSearch: () => void;
  onOpenLogin?: () => void;
  session: UserSession;
  onLogout: () => void;
  onRoleChanged?: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
  onOpenUserProfile: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentTab,
  onSelectTab,
  onOpenSearch,
  session,
  onLogout,
  isDark,
  onToggleTheme,
  onOpenUserProfile,
}) => {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const isUserAuthenticated = Boolean(session.isOwner);

  return (
    <header className="sticky top-0 z-40 w-full bg-white/90 dark:bg-neutral-950/90 backdrop-blur-md border-b border-neutral-200 dark:border-neutral-800 transition-colors">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-6 px-4 sm:px-6 py-3">
        
        {/* Brand Wordmark */}
        <button
          onClick={() => {
            if (isUserAuthenticated) {
              onSelectTab('portal');
            }
          }}
          className="text-lg font-bold tracking-tight text-neutral-900 dark:text-neutral-100 whitespace-nowrap shrink-0 flex items-center gap-2 hover:opacity-85 transition-opacity"
        >
          <span className="w-7 h-7 rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 flex items-center justify-center font-mono text-xs font-bold shadow-sm">
            IF
          </span>
          <span>InkFlow</span>
          <span className="text-[10px] font-normal px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 font-mono hidden sm:inline-block">
            Hub
          </span>
        </button>

        {/* If NOT logged in: Do not show tab bars */}
        {isUserAuthenticated && (
          <nav className="hidden lg:flex items-center gap-6 text-sm font-medium text-neutral-600 dark:text-neutral-400">
            <button
              onClick={() => onSelectTab('portal')}
              className={`hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors whitespace-nowrap shrink-0 ${
                currentTab === 'portal'
                  ? 'text-neutral-900 dark:text-neutral-100 font-semibold underline underline-offset-8 decoration-2'
                  : ''
              }`}
            >
              知识门户
            </button>
            <button
              onClick={() => onSelectTab('graph')}
              className={`hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                currentTab === 'graph'
                  ? 'text-neutral-900 dark:text-neutral-100 font-semibold underline underline-offset-8 decoration-2'
                  : ''
              }`}
            >
              <Share2 className="w-3.5 h-3.5" />
              <span>知识图谱</span>
            </button>
            <button
              onClick={() => onSelectTab('forum')}
              className={`hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                currentTab === 'forum'
                  ? 'text-neutral-900 dark:text-neutral-100 font-semibold underline underline-offset-8 decoration-2'
                  : ''
              }`}
            >
              <Radio className="w-3.5 h-3.5" />
              <span>共创广场</span>
            </button>
            <button
              onClick={() => onSelectTab('architecture')}
              className={`hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors whitespace-nowrap shrink-0 ${
                currentTab === 'architecture'
                  ? 'text-neutral-900 dark:text-neutral-100 font-semibold underline underline-offset-8 decoration-2'
                  : ''
              }`}
            >
              架构演进
            </button>
          </nav>
        )}

        {/* Right Section: Tools, Theme toggle & User Avatar with Dropdown */}
        <div className="flex items-center gap-2.5 shrink-0">
          
          {/* Quick Search Shortcut (Only when authenticated) */}
          {isUserAuthenticated && (
            <>
              <button
                onClick={onOpenSearch}
                className="hidden sm:flex items-center gap-2 px-2.5 py-1.5 text-xs text-neutral-500 bg-neutral-100 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 rounded-xl transition-colors whitespace-nowrap"
                title="快捷搜索 (⌘K)"
              >
                <Search className="w-3.5 h-3.5" />
                <kbd className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700">
                  ⌘K
                </kbd>
              </button>

              <button
                onClick={onOpenSearch}
                className="sm:hidden p-2 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white rounded-xl transition-colors"
                title="搜索"
              >
                <Search className="w-4 h-4" />
              </button>
            </>
          )}

          {/* Theme Toggle */}
          <button
            onClick={onToggleTheme}
            className="p-2 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white rounded-xl hover:bg-neutral-100 dark:hover:bg-neutral-900 transition-colors"
            title={isDark ? '切换亮色模式' : '切换暗色模式'}
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          {/* Authenticated: Small Avatar with Dropdown */}
          {isUserAuthenticated ? (
            <div className="relative" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => setIsDropdownOpen(prev => !prev)}
                className="flex items-center gap-1.5 p-1 pl-1.5 pr-2 rounded-full border border-neutral-200 dark:border-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-600 bg-neutral-50 dark:bg-neutral-900 transition-all focus:outline-none"
                title="主理人个人中心"
              >
                {/* User avatar circle */}
                <div className="w-6 h-6 rounded-full bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 flex items-center justify-center font-bold text-xs shadow-sm">
                  {session.username ? session.username.charAt(0).toUpperCase() : 'H'}
                </div>
                <span className="text-xs font-semibold text-neutral-800 dark:text-neutral-200 hidden sm:inline-block max-w-[80px] truncate">
                  {session.username || 'Owner'}
                </span>
                <ChevronDown className="w-3 h-3 text-neutral-400" />
              </button>

              {/* Dropdown Menu */}
              {isDropdownOpen && (
                <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-xl py-2 z-50 text-xs animate-fade-in">
                  
                  {/* User brief card */}
                  <div className="px-4 py-2.5 border-b border-neutral-100 dark:border-neutral-800">
                    <div className="font-bold text-neutral-900 dark:text-neutral-100 flex items-center justify-between">
                      <span>{session.username || 'Hecker'}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 font-mono">
                        在线
                      </span>
                    </div>
                    <div className="text-[11px] text-neutral-400 truncate mt-0.5">
                      知识库所有者 (Owner)
                    </div>
                  </div>

                  {/* Option 1: 用户管理 (Profile & Password settings) */}
                  <div className="p-1">
                    <button
                      onClick={() => {
                        setIsDropdownOpen(false);
                        onOpenUserProfile();
                      }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800/80 rounded-xl transition-colors text-left"
                    >
                      <User className="w-4 h-4 text-neutral-500" />
                      <span>用户管理</span>
                    </button>

                    {/* Option 2: 内容管理台 (Doc, Category, Tag, Backup management) */}
                    <button
                      onClick={() => {
                        setIsDropdownOpen(false);
                        onSelectTab('admin');
                      }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800/80 rounded-xl transition-colors text-left"
                    >
                      <LayoutDashboard className="w-4 h-4 text-neutral-500" />
                      <span>内容管理台</span>
                    </button>
                  </div>

                  <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />

                  {/* Option 3: 退出登录 (Logout) */}
                  <div className="p-1">
                    <button
                      onClick={() => {
                        setIsDropdownOpen(false);
                        onLogout();
                      }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-xl transition-colors text-left font-medium"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>退出登录</span>
                    </button>
                  </div>

                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-neutral-400 font-mono">
              访客未认证
            </div>
          )}

        </div>
      </div>
    </header>
  );
};
