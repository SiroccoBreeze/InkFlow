import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  ArrowLeft,
  Share2,
  Download,
  Copy,
  Check,
  Edit3,
  Paperclip,
  ExternalLink,
  Lock,
  EyeOff,
  BookOpen,
  Link2,
  Bookmark,
  Printer,
  Maximize2,
  Minimize2,
  Type,
  ArrowUp,
  List,
  X,
  Quote,
  Clock,
  Sparkles,
  Info,
  ZoomIn,
} from 'lucide-react';
import { Attachment, KnowledgeDoc, UserSession, WikiBacklink } from '../../types';
import { storage } from '../../services/storage';
import { hydrateAuthedImages, isLocalAssetUrl, loadAuthedAssetUrl } from '../../services/assetImages';
import {
  extractTableOfContents,
  parseFrontmatter,
  renderMarkdown,
  serializeToMarkdown,
} from '../../services/markdown';
import { DocComments } from './DocComments';
import { isTallArticleImage } from '../../services/articleImageLayout';

interface ArticleReaderProps {
  doc: KnowledgeDoc;
  onBack: () => void;
  onEdit?: (doc: KnowledgeDoc) => void;
  onSelectDocBySlug?: (slug: string) => void;
  onSelectDoc?: (doc: KnowledgeDoc) => void;
  session: UserSession;
  allDocs: KnowledgeDoc[];
}

type FontSize = 'sm' | 'base' | 'lg' | 'xl';
type FontFamily = 'sans' | 'serif' | 'mono';
type ContainerWidth = 'cozy' | 'standard' | 'wide';

// Inline magnifier used by the hover hint pill (static markup, no user data).
const ZOOM_HINT_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.3-4.3"></path><path d="M11 8v6"></path><path d="M8 11h6"></path></svg>';

/**
 * Wraps each image in a presentation frame so the reader can cap preview height
 * (with a fade for long screenshots) without touching the original file. The
 * existing Lightbox click delegation keeps working because the <img> stays in
 * the article container. Reader-only: this function is never called elsewhere.
 */
function decorateArticleImages(root: HTMLElement): void {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img'));
  for (const img of images) {
    if (img.closest('.article-img-frame')) continue;

    const frame = document.createElement('span');
    frame.className = 'article-img-frame';

    const fade = document.createElement('span');
    fade.className = 'article-img-fade';
    fade.setAttribute('aria-hidden', 'true');

    const hint = document.createElement('span');
    hint.className = 'article-img-hint';
    hint.setAttribute('aria-hidden', 'true');
    hint.innerHTML = `${ZOOM_HINT_SVG}<span>点击放大</span>`;
    const hintLabel = hint.querySelector('span');

    img.parentNode?.insertBefore(frame, img);
    frame.appendChild(img);
    frame.appendChild(fade);
    frame.appendChild(hint);

    // naturalWidth/naturalHeight are zero until the (possibly authenticated)
    // asset finishes loading, so classify after the load event when needed.
    const classify = () => {
      const isTall = isTallArticleImage(img.naturalWidth, img.naturalHeight);
      frame.classList.toggle('article-img-frame--tall', isTall);
      if (hintLabel) hintLabel.textContent = isTall ? '查看完整长图' : '点击放大';
    };

    if (img.complete && img.naturalWidth > 0) classify();
    else img.addEventListener('load', classify, { once: true });
  }
}

export const ArticleReader: React.FC<ArticleReaderProps> = ({
  doc,
  onBack,
  onEdit,
  onSelectDocBySlug,
  onSelectDoc,
  session,
  allDocs,
}) => {
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedRaw, setCopiedRaw] = useState(false);
  const [copiedCitation, setCopiedCitation] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState<string>('');
  const [readProgress, setReadProgress] = useState(0);
  const [showAttachments, setShowAttachments] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  const [showMobileToc, setShowMobileToc] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [zenMode, setZenMode] = useState(false);
  // Image lightbox: resolved source, accessible description, and whether the
  // original is a long screenshot (then it scrolls at readable width instead of
  // being squeezed to fit one viewport height).
  const [lightbox, setLightbox] = useState<{ src: string; alt: string; tall: boolean } | null>(null);

  // Bookmark state persisted locally
  const [isBookmarked, setIsBookmarked] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('inkflow_bookmarks');
      const list = saved ? JSON.parse(saved) : [];
      return list.includes(doc.id);
    } catch {
      return false;
    }
  });

  // Reading preferences persisted locally
  const [fontSize, setFontSize] = useState<FontSize>(() => {
    return (localStorage.getItem('inkflow_pref_fontsize') as FontSize) || 'base';
  });
  const [fontFamily, setFontFamily] = useState<FontFamily>(() => {
    return (localStorage.getItem('inkflow_pref_fontfamily') as FontFamily) || 'sans';
  });
  const [containerWidth, setContainerWidth] = useState<ContainerWidth>(() => {
    return (localStorage.getItem('inkflow_pref_width') as ContainerWidth) || 'standard';
  });

  const [toastNotice, setToastNotice] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isOwner = session.role === 'owner';

  // Directly render the markdown document content as written by user
  const contentMarkdown = useMemo(() => {
    const { body } = parseFrontmatter(doc.rawMarkdown || '');
    return body.trimStart();
  }, [doc.rawMarkdown]);

  const toc = extractTableOfContents(doc.rawMarkdown);
  const renderedHtml = renderMarkdown(contentMarkdown);
  const backlinks = storage.getBacklinks(doc.id);

  // Sync reading preferences to localStorage
  const handleSetFontSize = (size: FontSize) => {
    setFontSize(size);
    localStorage.setItem('inkflow_pref_fontsize', size);
  };

  const handleSetFontFamily = (family: FontFamily) => {
    setFontFamily(family);
    localStorage.setItem('inkflow_pref_fontfamily', family);
  };

  const handleSetWidth = (w: ContainerWidth) => {
    setContainerWidth(w);
    localStorage.setItem('inkflow_pref_width', w);
  };

  // Toggle Bookmark
  const handleToggleBookmark = () => {
    try {
      const saved = localStorage.getItem('inkflow_bookmarks');
      const list: string[] = saved ? JSON.parse(saved) : [];
      let updated: string[];
      if (list.includes(doc.id)) {
        updated = list.filter(id => id !== doc.id);
        setIsBookmarked(false);
      } else {
        updated = [...list, doc.id];
        setIsBookmarked(true);
      }
      localStorage.setItem('inkflow_bookmarks', JSON.stringify(updated));
    } catch (e) {
      console.error(e);
    }
  };

  // Scroll reading progress & active TOC tracking & back-to-top visibility
  useEffect(() => {
    const handleScroll = () => {
      const totalHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (totalHeight > 0) {
        const progress = Math.min(100, Math.max(0, (window.scrollY / totalHeight) * 100));
        setReadProgress(progress);
      }

      setShowBackToTop(window.scrollY > 400);

      // TOC active heading detection
      const headingElements = toc
        .map(item => document.getElementById(item.id))
        .filter((el): el is HTMLElement => el !== null);

      for (let i = headingElements.length - 1; i >= 0; i--) {
        const rect = headingElements[i].getBoundingClientRect();
        if (rect.top <= 140) {
          setActiveHeadingId(headingElements[i].id);
          break;
        }
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [toc]);

  // Scroll to top and reset state when viewing a different document
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setActiveHeadingId('');
    setReadProgress(0);
  }, [doc.id]);

  // Private assets need the owner token, which plain <img src> requests cannot send.
  useEffect(() => {
    const cleanup = hydrateAuthedImages(contentRef.current);
    return cleanup;
  }, [renderedHtml, zenMode]);

  // Reader-only image presentation: frame each inline image so long screenshots
  // are height-capped with a fade, and every image shows a hover zoom affordance.
  useEffect(() => {
    if (contentRef.current) decorateArticleImages(contentRef.current);
  }, [renderedHtml, zenMode]);

  // Click an inline image to open the lightbox preview
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const handleImageClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!(target instanceof HTMLImageElement) || !container.contains(target)) return;
      e.preventDefault();
      const src = target.currentSrc || target.src || target.getAttribute('src') || '';
      if (!src) return;

      const alt = target.alt || '';
      const tall = isTallArticleImage(target.naturalWidth, target.naturalHeight);

      // Assets not hydrated yet would 403 in the lightbox; resolve with the token first.
      if (isLocalAssetUrl(src)) {
        loadAuthedAssetUrl(src).then(resolved => {
          if (resolved) setLightbox({ src: resolved, alt, tall });
        });
        return;
      }
      setLightbox({ src, alt, tall });
    };

    container.addEventListener('click', handleImageClick);
    return () => container.removeEventListener('click', handleImageClick);
  }, [renderedHtml]);

  // Close the lightbox with Escape
  useEffect(() => {
    if (!lightbox) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightbox]);

  // Click delegation for [[WikiLinks]] inside rendered HTML
  useEffect(() => {
    const handleDocClick = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('[data-wikilink]');
      if (target) {
        e.preventDefault();
        e.stopPropagation();

        const rawTarget = decodeURIComponent(
          target.getAttribute('data-slug') || target.getAttribute('data-wikilink') || ''
        ).trim();

        if (!rawTarget) return;

        // Find document matching slug, title or id across all available docs
        const cleanTarget = rawTarget.toLowerCase();
        const matched =
          allDocs.find(
            d =>
              d.slug.trim().toLowerCase() === cleanTarget ||
              d.title.trim().toLowerCase() === cleanTarget ||
              d.id.trim().toLowerCase() === cleanTarget
          ) || storage.getDocByTitleOrSlug(rawTarget);

        const targetSlug = matched ? matched.slug : rawTarget;

        // Seamless navigation via onSelectDocBySlug
        if (onSelectDocBySlug) {
          onSelectDocBySlug(targetSlug);
        } else if (onSelectDoc && matched) {
          onSelectDoc(matched);
        } else {
          setToastNotice(`未找到目标知识文档「${rawTarget}」`);
          setTimeout(() => setToastNotice(null), 3500);
        }
      }
    };

    document.addEventListener('click', handleDocClick);
    return () => document.removeEventListener('click', handleDocClick);
  }, [allDocs, onSelectDocBySlug, onSelectDoc]);

  // Handle click on copy buttons inside rendered code blocks
  useEffect(() => {
    if (!contentRef.current) return;
    const copyButtons = contentRef.current.querySelectorAll<HTMLButtonElement>('.code-copy-btn');

    const cleanups: (() => void)[] = [];

    copyButtons.forEach(btn => {
      const container = btn.closest('.code-block-container') || btn.closest('pre');
      const codeEl = container?.querySelector('code') || container?.querySelector('pre');
      if (!codeEl) return;

      const handleClick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const codeText = codeEl.textContent || '';
        navigator.clipboard.writeText(codeText);
        const originalText = btn.innerText;
        btn.innerText = '已复制!';
        btn.classList.add('text-emerald-400');
        setTimeout(() => {
          btn.innerText = originalText || '复制';
          btn.classList.remove('text-emerald-400');
        }, 2000);
      };

      btn.addEventListener('click', handleClick);
      cleanups.push(() => btn.removeEventListener('click', handleClick));
    });

    return () => {
      cleanups.forEach(c => c());
    };
  }, [renderedHtml]);

  // Copy share URL
  const handleCopyShareLink = () => {
    const url = new URL(window.location.href);
    if (doc.visibility === 'unlisted' && doc.unlistedKey) {
      url.searchParams.set('share', doc.unlistedKey);
      url.searchParams.delete('doc');
    } else {
      url.searchParams.set('doc', doc.slug);
      url.searchParams.delete('share');
    }
    navigator.clipboard.writeText(url.toString());
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  // Copy raw markdown
  const handleCopyRawMarkdown = () => {
    const canonical = serializeToMarkdown(doc);
    navigator.clipboard.writeText(canonical);
    setCopiedRaw(true);
    setTimeout(() => setCopiedRaw(false), 2000);
  };

  // Copy Citation
  const handleCopyCitation = () => {
    const year = new Date(doc.createdAt).getFullYear();
    const citation = `${doc.author}. (${year}). ${doc.title}. InkFlow 个人知识库. ${window.location.href}`;
    navigator.clipboard.writeText(citation);
    setCopiedCitation(true);
    setTimeout(() => setCopiedCitation(false), 2000);
  };

  // Download .md
  const handleDownloadMarkdown = () => {
    const canonical = serializeToMarkdown(doc);
    const blob = new Blob([canonical], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${doc.slug || 'document'}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Print Document
  const handlePrint = () => {
    window.print();
  };

  // Scroll to top
  const handleScrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Container width classes
  const containerWidthClass = {
    cozy: 'max-w-2xl',
    standard: 'max-w-4xl',
    wide: 'max-w-6xl',
  }[containerWidth];

  // Font size classes
  const fontSizeClass = {
    sm: 'text-sm',
    base: 'text-base',
    lg: 'text-lg',
    xl: 'text-xl',
  }[fontSize];

  // Font family classes
  const fontFamilyClass = {
    sans: 'font-reading-sans',
    serif: 'font-reading-serif',
    mono: 'font-reading-mono',
  }[fontFamily];

  // Next and Previous articles in same category
  const publicDocs = allDocs.filter(
    d => isOwner || (d.visibility === 'public' && (d.status ?? 'published') === 'published')
  );
  const currentIndex = publicDocs.findIndex(d => d.id === doc.id);
  const prevDoc = currentIndex > 0 ? publicDocs[currentIndex - 1] : null;
  const nextDoc = currentIndex < publicDocs.length - 1 ? publicDocs[currentIndex + 1] : null;

  return (
    <div className={`relative min-h-screen bg-neutral-50 dark:bg-neutral-950 pb-28 ${fontFamilyClass}`}>
      
      {/* Reading Progress Indicator */}
      <div
        className="fixed top-0 left-0 h-0.5 bg-neutral-900 dark:bg-white z-50 transition-all duration-150 no-print"
        style={{ width: `${readProgress}%` }}
      />

      {/* Reader Top Action Bar (hidden in print and minimized in Zen Mode) */}
      {!zenMode ? (
        <div className="sticky top-[53px] z-30 bg-white/85 dark:bg-neutral-900/85 backdrop-blur-md border-b border-neutral-200 dark:border-neutral-800 transition-colors no-print">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 flex items-center justify-between gap-4">
            
            <button
              onClick={onBack}
              className="flex items-center gap-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors py-1 shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>返回知识库</span>
            </button>

            {/* Middle: Reading chapter and progress indicator */}
            <div className="hidden md:flex items-center gap-2 text-xs text-neutral-500 truncate max-w-sm">
              <span className="font-mono text-[11px] text-neutral-400">
                {Math.round(readProgress)}%
              </span>
              <span aria-hidden="true">·</span>
              <span className="truncate" title={doc.title}>{doc.title}</span>
            </div>

            {/* Action cluster */}
            <div className="flex items-center gap-1.5 shrink-0">
              
              {/* Bookmark Toggle */}
              <button
                onClick={handleToggleBookmark}
                className={`p-1.5 rounded-md transition-colors ${
                  isBookmarked
                    ? 'text-amber-600 bg-amber-50 dark:bg-amber-950/50 dark:text-amber-400'
                    : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                }`}
                title={isBookmarked ? '取消收藏' : '加入本地书签'}
              >
                <Bookmark className="w-3.5 h-3.5" fill={isBookmarked ? 'currentColor' : 'none'} />
              </button>

              {/* Typography Preferences Dropdown Trigger */}
              <div className="relative">
                <button
                  onClick={() => setShowPreferences(!showPreferences)}
                  className={`p-1.5 rounded-md transition-colors ${
                    showPreferences
                      ? 'bg-neutral-200 dark:bg-neutral-800 text-neutral-900 dark:text-white'
                      : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                  }`}
                  title="排版与阅读偏好"
                >
                  <Type className="w-3.5 h-3.5" />
                </button>

                {/* Preferences Menu */}
                {showPreferences && (
                  <div className="absolute right-0 top-8 z-50 w-64 p-4 rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-xl space-y-4 text-xs animate-fade-in">
                    <div>
                      <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-2">
                        字号大小
                      </div>
                      <div className="grid grid-cols-4 gap-1 p-1 bg-neutral-100 dark:bg-neutral-800 rounded-lg text-center font-mono text-[11px]">
                        {(['sm', 'base', 'lg', 'xl'] as FontSize[]).map(s => (
                          <button
                            key={s}
                            onClick={() => handleSetFontSize(s)}
                            className={`py-1 rounded transition-colors ${
                              fontSize === s
                                ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white shadow-xs font-bold'
                                : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
                            }`}
                          >
                            {s === 'sm' ? '14' : s === 'base' ? '16' : s === 'lg' ? '18' : '20'}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-2">
                        字体风格
                      </div>
                      <div className="grid grid-cols-3 gap-1 p-1 bg-neutral-100 dark:bg-neutral-800 rounded-lg text-center text-[11px]">
                        <button
                          onClick={() => handleSetFontFamily('sans')}
                          className={`py-1 rounded transition-colors ${
                            fontFamily === 'sans'
                              ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white shadow-xs font-semibold'
                              : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
                          }`}
                        >
                          无衬线
                        </button>
                        <button
                          onClick={() => handleSetFontFamily('serif')}
                          className={`py-1 rounded transition-colors font-serif ${
                            fontFamily === 'serif'
                              ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white shadow-xs font-semibold'
                              : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
                          }`}
                        >
                          宋体衬线
                        </button>
                        <button
                          onClick={() => handleSetFontFamily('mono')}
                          className={`py-1 rounded transition-colors font-mono ${
                            fontFamily === 'mono'
                              ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white shadow-xs font-semibold'
                              : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
                          }`}
                        >
                          等宽极客
                        </button>
                      </div>
                    </div>

                    <div>
                      <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-2">
                        正文版宽
                      </div>
                      <div className="grid grid-cols-3 gap-1 p-1 bg-neutral-100 dark:bg-neutral-800 rounded-lg text-center text-[11px]">
                        <button
                          onClick={() => handleSetWidth('cozy')}
                          className={`py-1 rounded transition-colors ${
                            containerWidth === 'cozy'
                              ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white shadow-xs font-semibold'
                              : 'text-neutral-500'
                          }`}
                        >
                          舒适
                        </button>
                        <button
                          onClick={() => handleSetWidth('standard')}
                          className={`py-1 rounded transition-colors ${
                            containerWidth === 'standard'
                              ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white shadow-xs font-semibold'
                              : 'text-neutral-500'
                          }`}
                        >
                          标准
                        </button>
                        <button
                          onClick={() => handleSetWidth('wide')}
                          className={`py-1 rounded transition-colors ${
                            containerWidth === 'wide'
                              ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white shadow-xs font-semibold'
                              : 'text-neutral-500'
                          }`}
                        >
                          通栏
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Zen Mode */}
              <button
                onClick={() => setZenMode(true)}
                className="p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-md transition-colors"
                title="开启全屏禅阅读模式"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>

              {/* Share link */}
              <button
                onClick={handleCopyShareLink}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-md transition-colors"
                title="复制分享链接"
              >
                {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Share2 className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline">{copiedLink ? '已复制' : '分享'}</span>
              </button>

              {/* Copy Raw MD */}
              <button
                onClick={handleCopyRawMarkdown}
                className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-md transition-colors"
                title="复制 Markdown 原文"
              >
                {copiedRaw ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedRaw ? '已复制' : '复制 MD'}</span>
              </button>

              {/* Citation */}
              <button
                onClick={handleCopyCitation}
                className="hidden md:flex items-center gap-1.5 px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-md transition-colors"
                title="复制学术/文章引用格式"
              >
                {copiedCitation ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Quote className="w-3.5 h-3.5" />}
                <span>引用</span>
              </button>

              {/* Print / PDF */}
              <button
                onClick={handlePrint}
                className="p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-md transition-colors"
                title="打印 / 导出为 PDF"
              >
                <Printer className="w-3.5 h-3.5" />
              </button>

              {/* Download .md */}
              <button
                onClick={handleDownloadMarkdown}
                className="p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-md transition-colors"
                title="下载独立 Markdown 文件"
              >
                <Download className="w-3.5 h-3.5" />
              </button>

              {(isOwner || (session.username && doc.author === session.username)) && onEdit && (
                <button
                  onClick={() => onEdit(doc)}
                  className="flex items-center gap-1.5 px-3 py-1 text-xs font-semibold text-white bg-neutral-900 dark:bg-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-100 rounded-md transition-colors ml-1 shadow-2xs"
                  title="直接编辑此文献"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>编辑</span>
                </button>
              )}
            </div>

          </div>
        </div>
      ) : (
        /* Floating Exit button for Zen Mode */
        <div className="fixed top-4 right-4 z-50 animate-fade-in no-print">
          <button
            onClick={() => setZenMode(false)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-neutral-900/90 text-white dark:bg-white/90 dark:text-neutral-900 text-xs font-medium backdrop-blur-md shadow-lg hover:scale-105 transition-all"
          >
            <Minimize2 className="w-3.5 h-3.5" />
            <span>退出禅模式</span>
          </button>
        </div>
      )}

      {/* Main Container */}
      <div className={`mx-auto px-4 sm:px-6 pt-8 ${zenMode ? containerWidthClass : 'max-w-7xl'}`}>
        <div className={`grid grid-cols-1 ${zenMode ? 'grid-cols-1' : 'lg:grid-cols-12'} gap-8 lg:gap-12`}>
          
          {/* Main Article Content Column (Left, Span 8) */}
          <article className={`${zenMode ? 'w-full' : 'lg:col-span-8'} min-w-0 max-w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl p-6 sm:p-12 shadow-xs transition-all`}>
            
            {/* Breadcrumbs (hidden in zen mode) */}
            {!zenMode && (
              <div className="flex items-center gap-2 text-xs text-neutral-500 mb-6 no-print">
                <button
                  onClick={onBack}
                  className="hover:text-neutral-900 dark:hover:text-neutral-100 transition-colors"
                >
                  知识门户
                </button>
                <span aria-hidden="true">/</span>
                <span className="text-neutral-700 dark:text-neutral-300 font-medium">
                  {doc.category}
                </span>
                <span aria-hidden="true">/</span>
                <span className="text-neutral-400 truncate max-w-xs" title={doc.title}>{doc.title}</span>
              </div>
            )}

            {/* Visibility Callout if Unlisted or Private */}
            {doc.visibility === 'unlisted' && (
              <div className="mb-6 p-4 rounded-xl bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 flex items-start gap-3 text-xs text-amber-900 dark:text-amber-200">
                <EyeOff className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">此文档为不公开链接（Unlisted）</span>
                  <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                    不在公开目录或搜索结果中展现，仅持有此私密 URL 的受邀伙伴可以阅读。
                  </p>
                </div>
              </div>
            )}

            {doc.visibility === 'private' && (
              <div className="mb-6 p-4 rounded-xl bg-rose-50/70 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 flex items-start gap-3 text-xs text-rose-900 dark:text-rose-200">
                <Lock className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">私密文档（Private）</span>
                  <p className="mt-0.5 text-rose-700 dark:text-rose-300">
                    仅 Owner 认证状态下可见，外部访客无权访问。
                  </p>
                </div>
              </div>
            )}

            {/* Clean Unboxed Metadata without pills */}
            <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500 pb-4 mb-6 border-b border-neutral-100 dark:border-neutral-800">
              <span className="font-semibold text-neutral-800 dark:text-neutral-200">{doc.author}</span>
              <span aria-hidden="true">·</span>
              <span>更新于 {new Date(doc.updatedAt).toLocaleDateString('zh-CN')}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{doc.wordCount} 字</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">预计 {doc.readingTimeMinutes} 分钟</span>
              {isOwner && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-[11px] text-neutral-400">v{doc.versionCount} 版本快照</span>
                </>
              )}
            </div>

            {/* Markdown Body Content with Custom Font Size */}
            <div
              ref={contentRef}
              className={`markdown-body markdown-body--zoomable ${fontSizeClass}`}
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />

            {/* Tags */}
            {doc.tags && doc.tags.length > 0 && (
              <div className="mt-12 pt-6 border-t border-neutral-100 dark:border-neutral-800 flex items-center gap-2 text-xs text-neutral-500 no-print">
                <span className="font-medium text-neutral-700 dark:text-neutral-300">知识标签：</span>
                <div className="flex flex-wrap gap-2">
                  {doc.tags.map(t => (
                    <span key={t} className="font-mono text-neutral-600 dark:text-neutral-400">
                      #{t}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Backlinks (Mentioned in...) Obsidian-style Knowledge Network */}
            {backlinks.length > 0 && (
              <div className="mt-8 p-5 rounded-xl bg-neutral-50/70 dark:bg-neutral-950/40 border border-neutral-200 dark:border-neutral-800 space-y-3 no-print">
                <div className="flex items-center gap-2 text-xs font-bold text-neutral-900 dark:text-neutral-100">
                  <Link2 className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  <span>反向引用链接 (Backlinks · {backlinks.length})</span>
                </div>
                <div className="space-y-2">
                  {backlinks.map(bl => (
                    <div
                      key={bl.sourceDocId}
                      onClick={() => {
                        const target = allDocs.find(d => d.id === bl.sourceDocId);
                        if (target && onSelectDoc) onSelectDoc(target);
                      }}
                      className="p-3 rounded-lg bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-600 transition-colors cursor-pointer text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between font-semibold text-neutral-900 dark:text-neutral-100">
                        <span>{bl.sourceDocTitle}</span>
                        <span className="text-[11px] font-normal text-neutral-400">{bl.sourceCategory}</span>
                      </div>
                      <p className="text-[11px] text-neutral-500 font-mono line-clamp-1">
                        {bl.excerpt}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Prev / Next Article Navigation (hidden in zen mode) */}
            {!zenMode && (
              <div className="mt-8 pt-6 border-t border-neutral-100 dark:border-neutral-800 grid grid-cols-1 sm:grid-cols-2 gap-4 no-print">
                {prevDoc ? (
                  <button
                    onClick={() => onSelectDocBySlug?.(prevDoc.slug)}
                    className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700 transition-colors text-left group"
                  >
                    <span className="text-xs text-neutral-400">上一篇</span>
                    <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 mt-1 truncate">
                      {prevDoc.title}
                    </h4>
                  </button>
                ) : <div />}

                {nextDoc ? (
                  <button
                    onClick={() => onSelectDocBySlug?.(nextDoc.slug)}
                    className="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700 transition-colors text-right group"
                  >
                    <span className="text-xs text-neutral-400">下一篇</span>
                    <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 mt-1 truncate">
                      {nextDoc.title}
                    </h4>
                  </button>
                ) : <div />}
              </div>
            )}

            {/* Reader Discussions & Comments */}
            {!zenMode && (
              <DocComments
                docId={doc.id}
                session={session}
                isOwner={isOwner}
              />
            )}

          </article>

          {/* Sticky Sidebar Column (Span 4) on the Right - Hidden in Zen Mode */}
          {!zenMode && (
            <aside className="lg:col-span-4 min-w-0 no-print">
              <div className="sticky top-24 max-h-[calc(100vh-110px)] flex flex-col space-y-4">
                
                {/* Table of Contents */}
                {toc.length > 0 && (
                  <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 shadow-xs flex flex-col flex-1 min-h-0">
                    <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2 pb-2 border-b border-neutral-100 dark:border-neutral-800 shrink-0">
                      <div className="flex items-center gap-2">
                        <BookOpen className="w-3.5 h-3.5" />
                        <span>本页大纲</span>
                      </div>
                      <span className="font-mono text-[10px] text-neutral-400">{toc.length} 个锚点</span>
                    </div>
                    <nav className="space-y-1 text-xs overflow-y-auto pr-1 flex-1">
                      {toc.map(item => {
                        const isActive = activeHeadingId === item.id;
                        return (
                          <a
                            key={item.id}
                            href={`#${item.id}`}
                            title={item.text}
                            aria-label={item.text}
                            onClick={e => {
                              e.preventDefault();
                              const el = document.getElementById(item.id);
                              if (el) {
                                el.scrollIntoView({ behavior: 'smooth' });
                              }
                            }}
                            className={`block py-1.5 transition-colors truncate ${
                              item.level === 3 ? 'pl-4' : 'pl-0'
                            } ${
                              isActive
                                ? 'text-neutral-900 dark:text-white font-semibold underline underline-offset-4 decoration-neutral-400'
                                : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-300'
                            }`}
                          >
                            {item.text}
                          </a>
                        );
                      })}
                    </nav>
                  </div>
                )}

                {/* Attachments Drawer / List */}
                {doc.attachments && doc.attachments.length > 0 && (
                  <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 shadow-xs shrink-0 max-h-48 overflow-y-auto">
                    <div className="flex items-center justify-between mb-2 pb-2 border-b border-neutral-100 dark:border-neutral-800">
                      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
                        <Paperclip className="w-3.5 h-3.5" />
                        <span>关联附件 ({doc.attachments.length})</span>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {doc.attachments.map(att => (
                        <div
                          key={att.id}
                          className="p-2 rounded-lg bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 flex items-center justify-between text-xs"
                        >
                          <div className="min-w-0 pr-2">
                            <p className="font-medium text-neutral-800 dark:text-neutral-200 truncate">
                              {att.name}
                            </p>
                            <p className="text-[11px] text-neutral-400 font-mono">
                              {(att.size / 1024).toFixed(1)} KB
                            </p>
                          </div>
                          <a
                            href={att.dataUrl}
                            download={att.name}
                            className="px-2 py-1 text-[11px] bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors shrink-0"
                          >
                            下载
                          </a>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Document Meta Info Card - Stationary and pinned together */}
                <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 shadow-xs text-xs space-y-2.5 shrink-0">
                  <div className="text-neutral-500 font-semibold uppercase tracking-wider text-[11px]">
                    元数据属性
                  </div>
                  <div className="space-y-2 text-neutral-600 dark:text-neutral-400">
                    <div className="flex justify-between">
                      <span className="text-neutral-400">所属分类</span>
                      <span className="font-medium text-neutral-800 dark:text-neutral-200">{doc.category}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-400">发布可见性</span>
                      <span className="capitalize font-medium text-neutral-800 dark:text-neutral-200">
                        {doc.visibility === 'public' ? '公开' : doc.visibility === 'unlisted' ? '未公开链接' : '私密'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-400">创建时间</span>
                      <span>{new Date(doc.createdAt).toLocaleDateString('zh-CN')}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-400">单源事实</span>
                      <span className="font-mono text-[11px]">CommonMark + Frontmatter</span>
                    </div>
                  </div>
                </div>

              </div>
            </aside>
          )}

        </div>
      </div>

      {/* Floating Action Dock: Mobile TOC & Back-to-Top Button */}
      <div className="fixed bottom-6 right-6 z-40 flex flex-col items-center gap-2 no-print">
        {/* Mobile TOC Drawer Trigger (only visible on smaller screens) */}
        {toc.length > 0 && (
          <button
            onClick={() => setShowMobileToc(true)}
            className="lg:hidden p-3 rounded-full bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 shadow-xl hover:scale-105 transition-all"
            title="查看文章大纲"
          >
            <List className="w-5 h-5" />
          </button>
        )}

        {/* Back to top button */}
        {showBackToTop && (
          <button
            onClick={handleScrollToTop}
            className="p-3 rounded-full bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 shadow-lg hover:scale-105 transition-all"
            title="返回顶部"
          >
            <ArrowUp className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Mobile Table of Contents Modal */}
      {showMobileToc && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-neutral-900/60 backdrop-blur-xs no-print">
          <div
            className="w-full max-w-md bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl p-6 max-h-[75vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-neutral-100 dark:border-neutral-800">
              <div className="flex items-center gap-2 text-sm font-bold text-neutral-900 dark:text-neutral-100">
                <BookOpen className="w-4 h-4" />
                <span>文章大纲 ({toc.length})</span>
              </div>
              <button
                onClick={() => setShowMobileToc(false)}
                className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-3 space-y-1 text-xs">
              {toc.map(item => {
                const isActive = activeHeadingId === item.id;
                return (
                  <a
                    key={item.id}
                    href={`#${item.id}`}
                    title={item.text}
                    aria-label={item.text}
                    onClick={e => {
                      e.preventDefault();
                      setShowMobileToc(false);
                      const el = document.getElementById(item.id);
                      if (el) el.scrollIntoView({ behavior: 'smooth' });
                    }}
                    className={`block py-2 px-2 rounded-lg transition-colors truncate ${
                      item.level === 3 ? 'pl-6' : 'pl-2'
                    } ${
                      isActive
                        ? 'bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-white font-bold'
                        : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800/50'
                    }`}
                  >
                    {item.text}
                  </a>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Friendly Wikilink Toast Notice */}
      {toastNotice && (
        <div className="fixed bottom-6 right-6 z-50 bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 px-4 py-2.5 rounded-xl shadow-xl text-xs font-medium animate-fade-in flex items-center gap-2">
          <Info className="w-4 h-4 text-amber-400 dark:text-amber-600 shrink-0" />
          <span>{toastNotice}</span>
        </div>
      )}

      {/* Image Lightbox — click an inline image to view it enlarged */}
      {lightbox && (
        <div
          className={`fixed inset-0 z-[60] bg-neutral-950/90 backdrop-blur-sm cursor-zoom-out animate-fade-in no-print ${
            lightbox.tall
              ? 'overflow-y-auto p-4 sm:p-8'
              : 'flex items-center justify-center p-4 sm:p-10'
          }`}
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.alt || '图片预览'}
        >
          <button
            type="button"
            onClick={() => setLightbox(null)}
            className="fixed top-4 right-4 z-10 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
            title="关闭预览 (ESC)"
          >
            <X className="w-5 h-5" />
          </button>

          {lightbox.alt && (
            <div className="fixed top-0 left-0 right-0 z-[5] px-16 py-4 text-center text-xs text-white/70 truncate pointer-events-none">
              {lightbox.alt}
            </div>
          )}

          {lightbox.tall ? (
            // Long screenshots: keep a readable width and let the viewer scroll,
            // instead of squeezing the whole capture into one viewport height.
            <img
              src={lightbox.src}
              alt={lightbox.alt}
              className="block w-auto h-auto max-w-[95vw] mx-auto my-16 rounded-lg shadow-2xl cursor-default"
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <img
              src={lightbox.src}
              alt={lightbox.alt}
              className="max-w-full max-h-full object-contain rounded-lg shadow-2xl cursor-default"
              onClick={e => e.stopPropagation()}
            />
          )}

          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 text-[11px] text-white/50 pointer-events-none">
            <ZoomIn className="w-3.5 h-3.5" />
            <span>点击背景或按 ESC 关闭</span>
          </div>
        </div>
      )}

    </div>
  );
};
