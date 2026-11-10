import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { PublicPortal } from './components/portal/PublicPortal';
import { ArticleReader } from './components/portal/ArticleReader';
import { CategoryListView } from './components/portal/CategoryListView';
import { TagListView } from './components/portal/TagListView';
import { ArchitectureView } from './components/portal/ArchitectureView';
import { KnowledgeGraph } from './components/portal/KnowledgeGraph';
import { KnowledgeForum } from './components/portal/KnowledgeForum';
import { AdminDashboard } from './components/admin/AdminDashboard';
import { DocEditor } from './components/admin/DocEditor';
import { SearchModal } from './components/common/SearchModal';
import { LoginPage } from './components/admin/LoginPage';
import { UserProfileModal } from './components/admin/UserProfileModal';
import { storage } from './services/storage';
import { apiClient } from './services/apiClient';
import { Category, KnowledgeDoc, UserSession } from './types';

export default function App() {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [session, setSession] = useState<UserSession>(() => storage.getSession());

  const [currentTab, setCurrentTab] = useState<'portal' | 'graph' | 'forum' | 'categories' | 'tags' | 'architecture' | 'admin' | 'login'>('portal');
  const [readingDoc, setReadingDoc] = useState<KnowledgeDoc | null>(null);
  const [editingDocFromReader, setEditingDocFromReader] = useState<KnowledgeDoc | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isUserProfileOpen, setIsUserProfileOpen] = useState(false);
  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('inkflow_theme');
      if (saved) return saved === 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });

  // Sync theme with html.dark class
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('inkflow_theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('inkflow_theme', 'light');
    }
  }, [isDark]);

  const toggleTheme = () => {
    setIsDark(prev => !prev);
  };

  // Reload data from storage
  const reloadData = () => {
    const loadedDocs = storage.getDocs();
    const loadedCategories = storage.getCategories();
    const currentSession = storage.getSession();
    setDocs([...loadedDocs]);
    setCategories([...loadedCategories]);
    setSession(currentSession);

    if (readingDoc) {
      const refreshed = loadedDocs.find(d => d.id === readingDoc.id);
      if (refreshed) {
        setReadingDoc(refreshed);
      }
    }
  };

  // Initial load & URL query param parsing (e.g. ?doc=slug or ?share=unlistedKey)
  useEffect(() => {
    reloadData();

    // Asynchronously sync latest from SQLite & physical Markdown disk
    storage.syncFromBackend().then(() => {
      reloadData();
    });

    const url = new URL(window.location.href);
    const docSlug = url.searchParams.get('doc');
    const shareKey = url.searchParams.get('share');

    if (shareKey) {
      const unlisted = storage.getDocByUnlistedKey(shareKey);
      if (unlisted) {
        setReadingDoc(unlisted);
      }
    } else if (docSlug) {
      const matched = storage.getDocBySlug(docSlug);
      if (matched) {
        setReadingDoc(matched);
      }
    }
  }, []);

  // Global CMD+K shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Open doc in reader and update URL query
  const handleOpenDoc = (doc: KnowledgeDoc) => {
    setReadingDoc(doc);

    // Fetch latest complete content directly from physical disk to guarantee full markdown body
    if (doc.id) {
      apiClient.getDocumentById(doc.id).then(res => {
        if (res.data?.rawMarkdown) {
          setReadingDoc(prev => (prev && prev.id === doc.id ? { ...prev, rawMarkdown: res.data.rawMarkdown } : prev));
        }
      }).catch(() => {});
    }

    const url = new URL(window.location.href);
    if (doc.visibility === 'unlisted' && doc.unlistedKey) {
      url.searchParams.set('share', doc.unlistedKey);
      url.searchParams.delete('doc');
    } else {
      url.searchParams.set('doc', doc.slug);
      url.searchParams.delete('share');
    }
    window.history.pushState({}, '', url.toString());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Close reader
  const handleBackToCatalog = () => {
    setReadingDoc(null);
    setEditingDocFromReader(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('doc');
    url.searchParams.delete('share');
    window.history.pushState({}, '', url.toString());
  };

  // Select tab with strict login protection for admin
  const handleSelectTab = (tab: 'portal' | 'graph' | 'forum' | 'categories' | 'tags' | 'architecture' | 'admin' | 'login') => {
    if (tab === 'admin' && !session.isOwner) {
      setCurrentTab('login');
    } else {
      setCurrentTab(tab);
    }
    setReadingDoc(null);
    setEditingDocFromReader(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('doc');
    url.searchParams.delete('share');
    window.history.pushState({}, '', url.toString());
  };

  // Select Category from listing
  const handleSelectCategoryFromView = (catName: string) => {
    setSelectedCategory(catName);
    setSelectedTag(null);
    setCurrentTab('portal');
  };

  // Select Tag from listing
  const handleSelectTagFromView = (tagName: string) => {
    setSelectedTag(tagName);
    setSelectedCategory(null);
    setCurrentTab('portal');
  };

  // Logout
  const handleLogout = () => {
    storage.logoutOwner();
    reloadData();
    if (currentTab === 'admin') {
      setCurrentTab('portal');
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 transition-colors">
      
      {/* Top Bar Header */}
      <Header
        currentTab={currentTab}
        onSelectTab={handleSelectTab}
        onOpenSearch={() => setIsSearchOpen(true)}
        session={session}
        onLogout={handleLogout}
        onRoleChanged={reloadData}
        isDark={isDark}
        onToggleTheme={toggleTheme}
        onOpenUserProfile={() => setIsUserProfileOpen(true)}
      />

      {/* Main Content Area */}
      <main className="flex-1">
        {/* Strict Authentication Gate: Non-logged in visitors can view nothing */}
        {!session.isOwner ? (
          <LoginPage
            onLoginSuccess={() => {
              reloadData();
              setCurrentTab('portal');
            }}
          />
        ) : editingDocFromReader ? (
          <DocEditor
            initialDoc={editingDocFromReader}
            onSaveSuccess={saved => {
              reloadData();
              setReadingDoc(saved);
              setEditingDocFromReader(null);
            }}
            onCancel={() => setEditingDocFromReader(null)}
            categories={categories}
            allTags={storage.getAllTags().map(t => t.name)}
          />
        ) : readingDoc ? (
          <ArticleReader
            doc={readingDoc}
            onBack={handleBackToCatalog}
            onEdit={
              session.isOwner || (session.username && readingDoc.author === session.username)
                ? doc => {
                    setEditingDocFromReader(doc);
                  }
                : undefined
            }
            onSelectDoc={handleOpenDoc}
            onSelectDocBySlug={slug => {
              const cleanSlug = slug.trim().toLowerCase();
              const target =
                docs.find(
                  d =>
                    d.slug.trim().toLowerCase() === cleanSlug ||
                    d.title.trim().toLowerCase() === cleanSlug ||
                    d.id.trim().toLowerCase() === cleanSlug
                ) || storage.getDocByTitleOrSlug(slug);

              if (target) {
                handleOpenDoc(target);
              }
            }}
            session={session}
            allDocs={docs}
          />
        ) : currentTab === 'portal' ? (
          <PublicPortal
            docs={docs}
            categories={categories}
            onSelectDoc={handleOpenDoc}
            onOpenSearch={() => setIsSearchOpen(true)}
            selectedCategory={selectedCategory}
            onSelectCategory={setSelectedCategory}
            selectedTag={selectedTag}
            onSelectTag={setSelectedTag}
          />
        ) : currentTab === 'graph' ? (
          <KnowledgeGraph onSelectDoc={handleOpenDoc} />
        ) : currentTab === 'forum' ? (
          <KnowledgeForum session={session} />
        ) : currentTab === 'categories' ? (
          <CategoryListView
            categories={categories}
            docs={docs}
            onSelectCategory={handleSelectCategoryFromView}
            isOwner={session.isOwner}
          />
        ) : currentTab === 'tags' ? (
          <TagListView
            docs={docs}
            onSelectTag={handleSelectTagFromView}
            isOwner={session.isOwner}
          />
        ) : currentTab === 'architecture' ? (
          <ArchitectureView />
        ) : currentTab === 'admin' ? (
          <AdminDashboard
            docs={docs}
            categories={categories}
            onRefreshData={reloadData}
            onViewDoc={handleOpenDoc}
            onLogout={handleLogout}
          />
        ) : (
          <PublicPortal
            docs={docs}
            categories={categories}
            onSelectDoc={handleOpenDoc}
            onOpenSearch={() => setIsSearchOpen(true)}
            selectedCategory={selectedCategory}
            onSelectCategory={setSelectedCategory}
            selectedTag={selectedTag}
            onSelectTag={setSelectedTag}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 py-8 transition-colors">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-neutral-500">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-neutral-800 dark:text-neutral-200">InkFlow</span>
            <span>· 本地优先个人专属知识库</span>
            <span aria-hidden="true">·</span>
            <span>Markdown 唯一事实来源</span>
          </div>

          {session.isOwner ? (
            <div className="flex items-center gap-4">
              <button
                onClick={() => handleSelectTab('graph')}
                className="hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
              >
                知识图谱
              </button>
              <button
                onClick={() => handleSelectTab('forum')}
                className="hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
              >
                共创广场
              </button>
              <button
                onClick={() => handleSelectTab('architecture')}
                className="hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
              >
                系统架构
              </button>
              <button
                onClick={() => setIsUserProfileOpen(true)}
                className="hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
              >
                用户管理
              </button>
              <span>© {new Date().getFullYear()} 保留所有权利</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-neutral-400">系统已锁定，仅主理人验证后可访问</span>
              <span>© {new Date().getFullYear()}</span>
            </div>
          )}
        </div>
      </footer>

      {/* Global Search Modal */}
      {session.isOwner && (
        <SearchModal
          isOpen={isSearchOpen}
          onClose={() => setIsSearchOpen(false)}
          docs={docs}
          onSelectDoc={handleOpenDoc}
          isOwner={session.isOwner}
        />
      )}

      {/* User Profile & Password Management Modal */}
      {session.isOwner && (
        <UserProfileModal
          isOpen={isUserProfileOpen}
          onClose={() => setIsUserProfileOpen(false)}
          session={session}
          onProfileUpdated={reloadData}
          onNavigateToAdmin={() => {
            setIsUserProfileOpen(false);
            setCurrentTab('admin');
          }}
        />
      )}
    </div>
  );
}

