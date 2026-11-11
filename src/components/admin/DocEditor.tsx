import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Save,
  Eye,
  Columns,
  Edit2,
  Paperclip,
  History,
  Download,
  Share2,
  Trash2,
  ArrowLeft,
  Heading1,
  Heading2,
  Heading3,
  Bold,
  Italic,
  Code,
  List,
  ListOrdered,
  Quote,
  Table as TableIcon,
  CheckSquare,
  Globe,
  EyeOff,
  Lock,
  Pin,
  Check,
  Maximize2,
  Minimize2,
  Search,
  X,
  Sparkles,
  User,
  Tag as TagIcon,
  Folder,
  FileText,
  Image as ImageIcon,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { Attachment, Category, DocStatus, DocVisibility, KnowledgeDoc } from '../../types';
import { storage } from '../../services/storage';
import { apiClient } from '../../services/apiClient';
import {
  extractTableOfContents,
  extractTitle,
  generateSlug,
  parseFrontmatter,
  renderMarkdown,
  serializeToMarkdown,
} from '../../services/markdown';
import { VersionHistoryModal } from './VersionHistoryModal';
import { AttachmentManager } from './AttachmentManager';
import { hydrateAuthedImages } from '../../services/assetImages';

interface DocEditorProps {
  initialDoc?: KnowledgeDoc | null;
  onSaveSuccess: (doc: KnowledgeDoc) => void;
  onCancel: () => void;
  categories: Category[];
  allTags: string[];
}

export const DocEditor: React.FC<DocEditorProps> = ({
  initialDoc,
  onSaveSuccess,
  onCancel,
  categories,
  allTags,
}) => {
  // Parse initial frontmatter from initialDoc rawMarkdown if present
  const parsedInitial = useMemo(() => {
    if (initialDoc?.rawMarkdown) {
      return parseFrontmatter(initialDoc.rawMarkdown).frontmatter;
    }
    return {};
  }, [initialDoc]);

  const [docId] = useState<string>(
    initialDoc?.id || `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  );
  const [title, setTitle] = useState<string>(
    initialDoc?.title || parsedInitial.title || ''
  );
  const [slug, setSlug] = useState<string>(
    initialDoc?.slug || ''
  );
  const [category, setCategory] = useState<string>(
    parsedInitial.category || initialDoc?.category || (categories[0]?.name || '未分类')
  );
  const [selectedTags, setSelectedTags] = useState<string[]>(
    (Array.isArray(parsedInitial.tags) ? parsedInitial.tags : initialDoc?.tags) || []
  );
  const [newTagInput, setNewTagInput] = useState('');
  const [visibility, setVisibility] = useState<DocVisibility>(
    ((parsedInitial.visibility && ['public', 'private', 'unlisted'].includes(parsedInitial.visibility))
      ? parsedInitial.visibility
      : initialDoc?.visibility || 'private') as DocVisibility
  );  // New documents start as unpublished drafts; publishing requires an explicit owner action.
  // Existing documents keep their current state (legacy docs without a status were published).
  const [status, setStatus] = useState<DocStatus>(
    ((parsedInitial.status && ['draft', 'published', 'archived'].includes(parsedInitial.status))
      ? parsedInitial.status
      : initialDoc
        ? initialDoc.status || 'published'
        : 'draft') as DocStatus
  );
  const [author, setAuthor] = useState<string>(
    parsedInitial.author || initialDoc?.author || 'Hecker'
  );
  const [unlistedKey, setUnlistedKey] = useState(
    initialDoc?.unlistedKey || Math.random().toString(36).slice(2, 10)
  );
  const [pinned, setPinned] = useState(initialDoc?.pinned || false);

  const [rawMarkdown, setRawMarkdown] = useState<string>(() => {
    if (initialDoc?.rawMarkdown) {
      const { body } = parseFrontmatter(initialDoc.rawMarkdown);
      return body.trimStart();
    }
    return '';
  });

  const [editorMode, setEditorMode] = useState<'split' | 'edit' | 'preview'>('split');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [showAttachmentModal, setShowAttachmentModal] = useState(false);
  const [isTagModalOpen, setIsTagModalOpen] = useState(false);
  const [tagSearchQuery, setTagSearchQuery] = useState('');
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<{
    code: string;
    message: string;
    retryable: boolean;
    conflict: boolean;
  } | null>(null);
  const [copiedShareLink, setCopiedShareLink] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [uploadToast, setUploadToast] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The fullscreen overlay renders its own textarea; the toolbar/insert helpers
  // must target whichever editor the user is actually typing in.
  const fullscreenTextareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const fullscreenPreviewRef = useRef<HTMLDivElement>(null);

  // Unified available tags list from storage and props
  const availableTagsList = useMemo(() => {
    const storageTags = storage.getAllTags();
    const map = new Map<string, number>();
    storageTags.forEach(t => map.set(t.name, t.count));
    allTags.forEach(t => {
      if (!map.has(t)) map.set(t, 0);
    });
    selectedTags.forEach(t => {
      if (!map.has(t)) map.set(t, 0);
    });
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (b.count || 0) - (a.count || 0) || a.name.localeCompare(b.name));
  }, [allTags, selectedTags]);

  // Filtered tags for search inside tag selector modal
  const filteredTags = useMemo(() => {
    const q = tagSearchQuery.trim().toLowerCase().replace(/^#/, '');
    if (!q) return availableTagsList;
    return availableTagsList.filter(t => t.name.toLowerCase().includes(q));
  }, [availableTagsList, tagSearchQuery]);

  // Build standard canonical frontmatter block for storage & export
  const buildFrontmatterBlock = (meta: {
    title: string;
    category: string;
    tags: string[];
    visibility: DocVisibility;
    status: DocStatus;
    author: string;
  }): string => {
    const tagsStr = `[${meta.tags.map(t => `"${t.replace(/"/g, '\\"')}"`).join(', ')}]`;
    return [
      '---',
      `title: "${meta.title.replace(/"/g, '\\"')}"`,
      `category: "${meta.category}"`,
      `tags: ${tagsStr}`,
      `visibility: "${meta.visibility}"`,
      `status: "${meta.status}"`,
      `author: "${meta.author || 'Hecker'}"`,
      '---',
    ].join('\n');
  };

  // When Markdown content is edited directly: pure markdown body
  const handleMarkdownChange = (newMd: string) => {
    const trimmed = newMd.trimStart();
    // If user pasted a full markdown file starting with Frontmatter, cleanly absorb into metadata and strip from body
    if (trimmed.startsWith('---')) {
      const { frontmatter, body } = parseFrontmatter(trimmed);
      if (frontmatter.title && typeof frontmatter.title === 'string') {
        setTitle(frontmatter.title);
      }
      if (frontmatter.category && typeof frontmatter.category === 'string') {
        setCategory(frontmatter.category);
      }
      if (Array.isArray(frontmatter.tags)) {
        const cleanTags = frontmatter.tags.map(t => String(t).trim()).filter(Boolean);
        setSelectedTags(cleanTags);
      }
      if (frontmatter.visibility && ['public', 'private', 'unlisted'].includes(frontmatter.visibility)) {
        setVisibility(frontmatter.visibility as DocVisibility);
      }
      if (frontmatter.status && ['draft', 'published', 'archived'].includes(frontmatter.status)) {
        setStatus(frontmatter.status as DocStatus);
      }
      if (frontmatter.author && typeof frontmatter.author === 'string') {
        setAuthor(frontmatter.author);
      }
      setRawMarkdown(body.trimStart());
      return;
    }

    setRawMarkdown(newMd);
  };

  // Top UI Change Handlers
  const handleTitleChange = (newTitle: string) => {
    setTitle(newTitle);
  };

  const handleCategoryChange = (newCat: string) => {
    setCategory(newCat);
  };

  const handleVisibilityChange = (newVis: DocVisibility) => {
    setVisibility(newVis);
  };

  const handleAuthorChange = (newAuthor: string) => {
    setAuthor(newAuthor);
  };

  const handleAddTag = (tagToAdd?: string) => {
    const clean = (tagToAdd || newTagInput).trim().replace(/^#/, '');
    if (!clean) return;
    if (!selectedTags.includes(clean)) {
      const updated = [...selectedTags, clean];
      setSelectedTags(updated);
      storage.addTag(clean);
    }
    setNewTagInput('');
  };

  const handleRemoveTag = (tagToRemove: string) => {
    const updated = selectedTags.filter(t => t !== tagToRemove);
    setSelectedTags(updated);
  };

  const handleToggleTag = (tagName: string) => {
    if (selectedTags.includes(tagName)) {
      handleRemoveTag(tagName);
    } else {
      handleAddTag(tagName);
    }
  };

  // Handle Ctrl+S / Cmd+S & Escape for fullscreen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [title, rawMarkdown, category, selectedTags, visibility, author, pinned, slug, isFullscreen, isSaving]);

  // Track newly uploaded assets during this editing session for unsaved draft cleanup
  const sessionNewAssetIds = useRef<string[]>([]);

  const handleCancel = async () => {
    // If this was a new unsaved document creation and new assets were uploaded during this session,
    // clean up those orphan files from backend physical disk and local storage
    if (!initialDoc && sessionNewAssetIds.current.length > 0) {
      const idsToClean = [...sessionNewAssetIds.current];
      sessionNewAssetIds.current = [];
      for (const assetId of idsToClean) {
        try {
          await apiClient.deleteAsset(assetId);
          storage.deleteAttachment(assetId);
        } catch (e) {
          console.error('Failed cleaning uncommitted session asset:', e);
        }
      }
    }
    onCancel();
  };

  const handleSave = async (note?: string): Promise<void> => {
    // Prevent duplicate requests from double clicks / rapid Ctrl+S.
    if (isSaving) return;

    const finalTitle = title.trim() || extractTitle(rawMarkdown, '无标题笔记');
    const finalSlug = slug.trim() || generateSlug(finalTitle);

    // Synthesize full canonical Markdown with standard Frontmatter for storage & export
    const fullMarkdown = [
      buildFrontmatterBlock({
        title: finalTitle,
        category,
        tags: selectedTags,
        visibility,
        status,
        author: author.trim() || 'Hecker',
      }),
      '',
      rawMarkdown.trimStart(),
    ].join('\n');

    setIsSaving(true);
    setSaveError(null);
    setSaveStatus(null);

    try {
      const result = await storage.saveDoc(
        {
          id: docId,
          title: finalTitle,
          slug: finalSlug,
          rawMarkdown: fullMarkdown,
          category,
          tags: selectedTags,
          visibility,
          status,
          author: author.trim() || 'Hecker',
          unlistedKey: visibility === 'unlisted' ? unlistedKey : undefined,
          pinned,
        },
        note || (initialDoc ? '在个人管理工作台保存修改' : '创建新文档')
      );

      if (!result.success) {
        // Editing state (rawMarkdown/title/...) is untouched, so the user can retry
        // or copy the content out. Never report success here.
        setSaveError({
          code: result.error?.code || 'SAVE_FAILED',
          message: result.error?.message || '保存失败，内容仍保留在编辑器中。',
          retryable: Boolean(result.error?.retryable),
          conflict: result.error?.code === 'VERSION_CONFLICT',
        });
        return;
      }

      // Assets are now committed with the document save, so draft cleanup is no
      // longer needed for this editing session.
      sessionNewAssetIds.current = [];

      setSaveStatus('已成功保存');
      setTimeout(() => setSaveStatus(null), 2500);
      onSaveSuccess(result.doc);
    } finally {
      setIsSaving(false);
    }
  };

  // Insert markdown syntax helper
  const insertText = (before: string, after: string = '', defaultText: string = '') => {
    const textarea = isFullscreen ? fullscreenTextareaRef.current : textareaRef.current;
    // The fullscreen overlay hides the inline textarea; without its own ref there
    // is no cursor to insert at, so append to the end of the document instead.
    if (!textarea) {
      handleMarkdownChange(rawMarkdown + (rawMarkdown.endsWith('\n') ? '' : '\n') + before + defaultText + after);
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const current = textarea.value;
    const selected = current.substring(start, end) || defaultText;

    const updated = current.substring(0, start) + before + selected + after + current.substring(end);
    handleMarkdownChange(updated);

    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
    }, 10);
  };

  const handleCopyUnlistedLink = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('share', unlistedKey);
    url.searchParams.delete('doc');
    navigator.clipboard.writeText(url.toString());
    setCopiedShareLink(true);
    setTimeout(() => setCopiedShareLink(false), 2000);
  };

  // Upload file and insert Markdown link/image at cursor
  const uploadAndInsertFile = async (file: File) => {
    setIsUploadingFile(true);
    setUploadToast(`正在持久化 ${file.name} 至 storage/assets/...`);
    const reader = new FileReader();

    reader.onload = async e => {
      const base64Data = e.target?.result as string;
      try {
        const res = await apiClient.uploadAsset(file.name, file.type, base64Data);
        if (res.data) {
          // Track for unsaved draft cleanup if not saved
          sessionNewAssetIds.current.push(res.data.id);

          const isImage = file.type.startsWith('image/');
          const snippet = isImage
            ? `\n![${res.data.filename}](${res.data.url})\n`
            : `\n[📎 ${res.data.filename}](${res.data.url})\n`;

          insertText(snippet);
          setUploadToast(`已成功保存至 storage/assets/${res.data.id} 并插入正文！`);
          setTimeout(() => setUploadToast(null), 3000);
        } else {
          setUploadToast(`上传失败: ${res.error?.message || '未知错误'}`);
          setTimeout(() => setUploadToast(null), 3000);
        }
      } catch (err: any) {
        setUploadToast(`上传出错: ${err?.message || '网络异常'}`);
        setTimeout(() => setUploadToast(null), 3000);
      } finally {
        setIsUploadingFile(false);
      }
    };

    reader.onerror = () => {
      setIsUploadingFile(false);
      setUploadToast('读取本地文件失败');
      setTimeout(() => setUploadToast(null), 3000);
    };

    reader.readAsDataURL(file);
  };

  // Handle image pasting from clipboard (e.g. Snipping tool, screenshots)
  const handlePaste = (e: React.ClipboardEvent) => {
    if (e.clipboardData && e.clipboardData.items) {
      for (let i = 0; i < e.clipboardData.items.length; i++) {
        const item = e.clipboardData.items[i];
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            uploadAndInsertFile(file);
          }
          return;
        }
      }
    }
  };

  // Handle drag and drop files onto textarea
  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      setIsDraggingFile(true);
    }
  };

  const handleDragLeave = () => {
    setIsDraggingFile(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        uploadAndInsertFile(e.dataTransfer.files[i]);
      }
    }
  };

  // Local asset images require the owner token, which a bare <img src> cannot send.
  // After each preview render, swap those sources for authenticated object URLs so
  // a freshly pasted screenshot shows up in the right-hand preview immediately.
  useEffect(() => {
    const cleanups = [hydrateAuthedImages(previewRef.current), hydrateAuthedImages(fullscreenPreviewRef.current)];
    return () => cleanups.forEach(fn => fn());
  }, [rawMarkdown, editorMode, isFullscreen]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      
      {/* Sleek Top Navigation Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center gap-3">
          <button
            onClick={handleCancel}
            className="p-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-600 dark:text-neutral-400 transition-colors flex items-center gap-1.5 text-xs font-medium"
            title="返回文档列表"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>返回</span>
          </button>
          
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-200 truncate max-w-[200px] sm:max-w-xs">
              {title || '新知识文献'}
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span>纯净 Markdown 写作</span>
            </span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          {initialDoc && (
            <button
              type="button"
              onClick={() => setShowVersionModal(true)}
              className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-600 dark:text-neutral-400 transition-colors flex items-center gap-1"
            >
              <History className="w-3.5 h-3.5" />
              <span>快照 ({initialDoc.versionCount})</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowAttachmentModal(true)}
            className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-600 dark:text-neutral-400 transition-colors flex items-center gap-1"
          >
            <Paperclip className="w-3.5 h-3.5" />
            <span>附件</span>
          </button>

          <button
            type="button"
            onClick={() => handleSave()}
            disabled={isSaving}
            className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 hover:opacity-90 transition-opacity flex items-center gap-1.5 shadow-xs disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {isSaving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            <span>{isSaving ? '保存中...' : '保存 (⌘S)'}</span>
          </button>

          {saveStatus && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium animate-fade-in flex items-center gap-1">
              <Check className="w-3.5 h-3.5" />
              <span>{saveStatus}</span>
            </span>
          )}
        </div>
      </div>

      {/* Reconstructed Minimalist & Friendly Document Properties Bar */}
      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 space-y-3 shadow-xs">
        {/* Document Title Input */}
        <div>
          <input
            type="text"
            value={title}
            onChange={e => handleTitleChange(e.target.value)}
            placeholder="请输入文档标题..."
            className="w-full text-xl sm:text-2xl font-bold bg-transparent border-0 outline-none text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400/70 dark:placeholder:text-neutral-500/70 placeholder:font-normal leading-tight"
          />
        </div>

        {/* Clean Single-Row Properties Strip */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-neutral-100 dark:border-neutral-800 text-xs">
          
          {/* Category Dropdown Capsule */}
          <div className="flex items-center gap-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg px-2.5 py-1 text-neutral-700 dark:text-neutral-300">
            <Folder className="w-3.5 h-3.5 text-amber-500" />
            <span className="text-neutral-400 text-[11px]">分类:</span>
            <select
              value={category}
              onChange={e => handleCategoryChange(e.target.value)}
              className="bg-transparent font-medium outline-none text-neutral-900 dark:text-neutral-100 cursor-pointer"
            >
              {categories.map(c => (
                <option key={c.id} value={c.name} className="bg-white dark:bg-neutral-900">
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Visibility Capsule */}
          <div className="flex items-center gap-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg px-2.5 py-1 text-neutral-700 dark:text-neutral-300">
            {visibility === 'public' && <Globe className="w-3.5 h-3.5 text-emerald-500" />}
            {visibility === 'unlisted' && <EyeOff className="w-3.5 h-3.5 text-amber-500" />}
            {visibility === 'private' && <Lock className="w-3.5 h-3.5 text-rose-500" />}
            <span className="text-neutral-400 text-[11px]">可见性:</span>
            <select
              value={visibility}
              onChange={e => handleVisibilityChange(e.target.value as DocVisibility)}
              className="bg-transparent font-medium outline-none text-neutral-900 dark:text-neutral-100 cursor-pointer"
            >
              <option value="public" className="bg-white dark:bg-neutral-900">公开 (Public)</option>
              <option value="unlisted" className="bg-white dark:bg-neutral-900">未公开链接 (Unlisted)</option>
              <option value="private" className="bg-white dark:bg-neutral-900">私密 (Private)</option>
            </select>
            {visibility === 'unlisted' && (
              <button
                type="button"
                onClick={handleCopyUnlistedLink}
                className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5 ml-1"
                title="复制未公开链接"
              >
                {copiedShareLink ? <Check className="w-3 h-3 text-emerald-600" /> : <Share2 className="w-3 h-3" />}
              </button>
            )}
          </div>

          {/* Publish Status Capsule — anonymous visitors only ever see published documents */}
          <div className="flex items-center gap-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg px-2.5 py-1 text-neutral-700 dark:text-neutral-300">
            <FileText className="w-3.5 h-3.5 text-sky-500" />
            <span className="text-neutral-400 text-[11px]">状态:</span>
            <select
              value={status}
              onChange={e => setStatus(e.target.value as DocStatus)}
              className="bg-transparent font-medium outline-none text-neutral-900 dark:text-neutral-100 cursor-pointer"
            >
              <option value="draft" className="bg-white dark:bg-neutral-900">草稿 (仅自己可见)</option>
              <option value="published" className="bg-white dark:bg-neutral-900">已发布</option>
              <option value="archived" className="bg-white dark:bg-neutral-900">已归档</option>
            </select>
          </div>

          {/* Author Capsule */}
          <div className="flex items-center gap-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg px-2.5 py-1 text-neutral-700 dark:text-neutral-300">
            <User className="w-3.5 h-3.5 text-indigo-500" />
            <span className="text-neutral-400 text-[11px]">作者:</span>
            <input
              type="text"
              value={author}
              onChange={e => handleAuthorChange(e.target.value)}
              placeholder="作者署名"
              className="w-20 bg-transparent font-medium outline-none text-neutral-900 dark:text-neutral-100"
            />
          </div>

          {/* Pinned Toggle Capsule */}
          <button
            type="button"
            onClick={() => setPinned(!pinned)}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 transition-colors border ${
              pinned
                ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300 font-semibold'
                : 'bg-neutral-50 dark:bg-neutral-950 border-neutral-200 dark:border-neutral-800 text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
            }`}
          >
            <Pin className={`w-3.5 h-3.5 ${pinned ? 'text-amber-600 dark:text-amber-400' : 'rotate-45'}`} />
            <span>{pinned ? '已置顶' : '置顶'}</span>
          </button>

          {/* Tags Selected Display & Modal Trigger Button */}
          <div className="flex flex-wrap items-center gap-1.5 ml-auto">
            {selectedTags.length > 0 ? (
              selectedTags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 font-mono text-[11px] border border-neutral-200/60 dark:border-neutral-700/60"
                >
                  <span>#{tag}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveTag(tag)}
                    className="text-neutral-400 hover:text-rose-600 dark:hover:text-rose-400 leading-none ml-0.5 text-xs"
                    title={`移除 #${tag}`}
                  >
                    ×
                  </button>
                </span>
              ))
            ) : (
              <span className="text-[11px] text-neutral-400 dark:text-neutral-500 italic mr-1">
                未选择标签
              </span>
            )}

            {/* Interactive Tag Selector Dialog Button */}
            <button
              type="button"
              onClick={() => setIsTagModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-neutral-50 hover:bg-neutral-100 dark:bg-neutral-900 dark:hover:bg-neutral-800 text-neutral-800 dark:text-neutral-200 border border-dashed border-neutral-300 dark:border-neutral-700 text-xs font-medium transition-colors"
              title="打开标签库弹窗检索与选择"
            >
              <TagIcon className="w-3.5 h-3.5 text-neutral-500" />
              <span>+ 选择/管理标签</span>
              {selectedTags.length > 0 && (
                <span className="text-[10px] bg-neutral-200 dark:bg-neutral-800 px-1.5 py-0.2 rounded-full font-mono">
                  {selectedTags.length}
                </span>
              )}
            </button>
          </div>

        </div>
      </div>

      {/* Save failure feedback: editing state is preserved for retry/copy */}
      {saveError && (
        <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-xs text-rose-800 dark:text-rose-200 flex items-start gap-2 animate-fade-in">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="font-semibold">
              {saveError.conflict ? '保存被拒绝：版本冲突' : '保存失败'}
            </div>
            <p className="mt-0.5 leading-relaxed">{saveError.message}</p>
            <p className="mt-1 text-[11px] opacity-80">
              当前编辑内容不会被清空；可复制内容后刷新页面，或直接重试。
            </p>
          </div>
          {saveError.retryable && (
            <button
              type="button"
              onClick={() => handleSave()}
              disabled={isSaving}
              className="shrink-0 px-2.5 py-1 rounded-md bg-rose-600 text-white font-semibold hover:bg-rose-700 disabled:opacity-50"
            >
              重试保存
            </button>
          )}
        </div>
      )}

      {/* Editor & Preview Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 p-2 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl text-xs text-neutral-600 dark:text-neutral-400">
        
        {/* Markdown Helpers */}
        <div className="flex flex-wrap items-center gap-1">
          <button
            onClick={() => insertText('# ', '', '一级标题')}
            className="p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded"
            title="一级标题 (H1)"
          >
            <Heading1 className="w-4 h-4" />
          </button>
          <button
            onClick={() => insertText('## ', '', '二级标题')}
            className="p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded"
            title="二级标题 (H2)"
          >
            <Heading2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => insertText('### ', '', '三级标题')}
            className="p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded"
            title="三级标题 (H3)"
          >
            <Heading3 className="w-4 h-4" />
          </button>

          <span className="w-px h-4 bg-neutral-200 dark:border-neutral-800 mx-1" />

          <button
            onClick={() => insertText('**', '**', '加粗文本')}
            className="p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded"
            title="加粗 (Bold)"
          >
            <Bold className="w-4 h-4" />
          </button>
          <button
            onClick={() => insertText('*', '*', '斜体文本')}
            className="p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded"
            title="斜体 (Italic)"
          >
            <Italic className="w-4 h-4" />
          </button>
          <button
            onClick={() => insertText('`', '`', 'code')}
            className="p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded"
            title="行内代码"
          >
            <Code className="w-4 h-4" />
          </button>

          <span className="w-px h-4 bg-neutral-200 dark:border-neutral-800 mx-1" />

          <button
            onClick={() => insertText('- ', '', '列表项')}
            className="p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded"
            title="无序列表"
          >
            <List className="w-4 h-4" />
          </button>
          <button
            onClick={() => insertText('1. ', '', '有序列表项')}
            className="p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded"
            title="有序列表"
          >
            <ListOrdered className="w-4 h-4" />
          </button>
          <button
            onClick={() => insertText('- [ ] ', '', '待办事项')}
            className="p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded"
            title="任务复选框"
          >
            <CheckSquare className="w-4 h-4" />
          </button>
          <button
            onClick={() => insertText('> ', '', '引用语录')}
            className="p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded"
            title="块级引用"
          >
            <Quote className="w-4 h-4" />
          </button>
          <button
            onClick={() =>
              insertText(
                '| 列 1 | 列 2 | 列 3 |\n| :--- | :--- | :--- |\n| 内容 A | 内容 B | 内容 C |\n'
              )
            }
            className="p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded"
            title="插入表格"
          >
            <TableIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => insertText('```typescript\n', '\n```', '// 示例代码')}
            className="px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded font-mono text-[11px]"
            title="代码块"
          >
            &lt;/&gt;
          </button>
          <button
            type="button"
            onClick={() => setShowAttachmentModal(true)}
            className="p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded flex items-center gap-1 text-blue-600 dark:text-blue-400"
            title="插入图片 / 媒体素材（支持拖拽与截图粘贴，物理落盘）"
          >
            <ImageIcon className="w-4 h-4" />
            <span className="text-[11px] font-medium hidden md:inline">图片</span>
          </button>
        </div>

        {/* View Mode Controls & Fullscreen Toggle */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-neutral-100 dark:bg-neutral-800 p-1 rounded-lg">
            <button
              onClick={() => setEditorMode('split')}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                editorMode === 'split'
                  ? 'bg-white dark:bg-neutral-900 text-blue-600 dark:text-blue-400 shadow-xs ring-1 ring-neutral-200 dark:ring-neutral-700'
                  : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100'
              }`}
              title="双栏分屏：左侧实时编辑，右侧同步渲染预览"
            >
              <Columns className="w-3.5 h-3.5" />
              <span>🪟 双栏分屏</span>
            </button>

            <button
              onClick={() => setEditorMode('edit')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1 ${
                editorMode === 'edit'
                  ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 shadow-xs'
                  : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100'
              }`}
              title="单栏纯文本 Markdown 编写"
            >
              <Edit2 className="w-3.5 h-3.5" />
              <span>源码编辑</span>
            </button>

            <button
              onClick={() => setEditorMode('preview')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1 ${
                editorMode === 'preview'
                  ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 shadow-xs'
                  : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100'
              }`}
              title="完整全宽阅读排版效果"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>效果预览</span>
            </button>
          </div>

          {/* Fullscreen Zen Mode Button */}
          <button
            type="button"
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300 transition-colors flex items-center gap-1"
            title={isFullscreen ? "退出全屏 (ESC)" : "全屏专注编写"}
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4 text-blue-600" /> : <Maximize2 className="w-4 h-4" />}
            <span className="hidden sm:inline text-xs">{isFullscreen ? '退出全屏' : '全屏专注'}</span>
          </button>
        </div>
      </div>

      {/* Editor & Preview Workspace Container */}
      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl overflow-hidden shadow-xs">
        <div
          className={`grid min-h-[550px] divide-y lg:divide-y-0 lg:divide-x divide-neutral-200 dark:divide-neutral-800 ${
            editorMode === 'split'
              ? 'grid-cols-1 lg:grid-cols-2'
              : editorMode === 'edit'
              ? 'grid-cols-1'
              : 'grid-cols-1'
          }`}
        >
          {/* Editor Pane with Drag & Drop and Paste Support */}
          {(editorMode === 'split' || editorMode === 'edit') && (
            <div
              className={`relative flex flex-col h-full bg-neutral-50/30 dark:bg-neutral-950/30 transition-colors ${
                isDraggingFile ? 'bg-blue-50/40 dark:bg-blue-950/40 ring-2 ring-blue-500' : ''
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <textarea
                ref={textareaRef}
                value={rawMarkdown}
                onChange={e => handleMarkdownChange(e.target.value)}
                onPaste={handlePaste}
                placeholder="请输入正文内容（支持 Markdown 语法与边编辑边即时渲染，支持粘贴截图或拖拽文件上传）..."
                className="w-full h-full min-h-[550px] p-6 text-sm font-mono leading-relaxed bg-transparent text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400/60 dark:placeholder:text-neutral-500/60 placeholder:italic outline-none resize-none"
                spellCheck={false}
              />

              {isDraggingFile && (
                <div className="absolute inset-0 pointer-events-none flex items-center justify-center bg-blue-500/10 dark:bg-blue-500/20 border-2 border-dashed border-blue-500 rounded-xl m-3 backdrop-blur-2xs">
                  <div className="bg-white dark:bg-neutral-900 px-5 py-3 rounded-xl shadow-xl border border-blue-200 dark:border-blue-800 text-xs font-semibold text-blue-600 dark:text-blue-400 flex items-center gap-2">
                    <ImageIcon className="w-5 h-5 animate-bounce" />
                    <span>松开鼠标立即保存至 storage/assets/ 并插入图片链接</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Preview Pane with Instant Render */}
          {(editorMode === 'split' || editorMode === 'preview') && (
            <div className="p-6 sm:p-10 overflow-y-auto max-h-[700px] bg-white dark:bg-neutral-900">
              {rawMarkdown.trim() ? (
                <div
                  ref={previewRef}
                  className="markdown-body"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(rawMarkdown) }}
                />
              ) : (
                <div className="h-full min-h-[350px] flex flex-col items-center justify-center text-center p-8 text-neutral-400 dark:text-neutral-500 space-y-3 select-none">
                  <div className="w-12 h-12 rounded-2xl bg-neutral-100 dark:bg-neutral-800/80 border border-neutral-200 dark:border-neutral-700/60 flex items-center justify-center text-blue-500">
                    <Sparkles className="w-6 h-6 animate-pulse" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                      即时渲染引擎就绪
                    </p>
                    <p className="text-xs text-neutral-400 dark:text-neutral-500 max-w-xs leading-relaxed">
                      在左侧输入 Markdown 语法，此处将即时同步呈现排版样式、代码块与多媒体。
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Status Bar */}
        <div className="px-6 py-2.5 bg-neutral-50 dark:bg-neutral-950 border-t border-neutral-200 dark:border-neutral-800 text-xs text-neutral-500 flex flex-wrap items-center justify-between gap-4 font-mono">
          <div className="flex items-center gap-4">
            <span>字符数: {rawMarkdown.length}</span>
            <span>行数: {rawMarkdown.split('\n').length}</span>
            <span>唯一事实来源: Canonical Markdown</span>
          </div>
          <div>按 ⌘S / Ctrl+S 快速保存 · 点击全屏专注沉浸写作</div>
        </div>
      </div>

      {/* Fullscreen Zen Mode Modal (Overlay over entire viewport) */}
      {isFullscreen && (
        <div className="fixed inset-0 z-50 bg-white dark:bg-neutral-950 flex flex-col p-4 sm:p-6 space-y-3">
          
          {/* Fullscreen Minimal Top Navigation */}
          <div className="flex items-center justify-between pb-3 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
            <div className="flex items-center gap-3">
              <span className="font-bold text-sm text-neutral-900 dark:text-neutral-100 truncate max-w-md">
                {title || '无标题文档'}
              </span>
              <span className="text-xs text-neutral-400 font-mono hidden sm:inline">
                {rawMarkdown.length} 字符 · {rawMarkdown.split('\n').length} 行
              </span>
            </div>

            <div className="flex items-center gap-3">
              {/* Mode switch */}
              <div className="flex items-center gap-1 bg-neutral-100 dark:bg-neutral-800 p-1 rounded-lg text-xs">
                <button
                  onClick={() => setEditorMode('split')}
                  className={`px-2.5 py-1 rounded transition-colors flex items-center gap-1 ${
                    editorMode === 'split'
                      ? 'bg-white dark:bg-neutral-900 text-blue-600 dark:text-blue-400 font-semibold shadow-2xs'
                      : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100'
                  }`}
                >
                  <Columns className="w-3.5 h-3.5" />
                  <span>🪟 双栏分屏</span>
                </button>
                <button
                  onClick={() => setEditorMode('edit')}
                  className={`px-2.5 py-1 rounded transition-colors flex items-center gap-1 ${
                    editorMode === 'edit'
                      ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 font-semibold shadow-2xs'
                      : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100'
                  }`}
                >
                  <Edit2 className="w-3.5 h-3.5" />
                  <span>源码编辑</span>
                </button>
                <button
                  onClick={() => setEditorMode('preview')}
                  className={`px-2.5 py-1 rounded transition-colors flex items-center gap-1 ${
                    editorMode === 'preview'
                      ? 'bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 font-semibold shadow-2xs'
                      : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>效果预览</span>
                </button>
              </div>

              {/* Quick Save */}
              <button
                type="button"
                onClick={() => handleSave()}
                disabled={isSaving}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 hover:opacity-90 flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                <span>{isSaving ? '保存中...' : '保存 (⌘S)'}</span>
              </button>

              {/* Exit Fullscreen */}
              <button
                type="button"
                onClick={() => setIsFullscreen(false)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300 flex items-center gap-1.5"
                title="退出全屏 (ESC)"
              >
                <Minimize2 className="w-3.5 h-3.5" />
                <span>退出全屏 (ESC)</span>
              </button>
            </div>
          </div>

          {/* Fullscreen Workspace Pane */}
          <div className="flex-1 min-h-0 bg-neutral-50/50 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-2xl overflow-hidden flex flex-col">
            {saveError && (
              <div className="px-4 py-2 bg-rose-50 dark:bg-rose-950/50 border-b border-rose-200 dark:border-rose-900/60 text-[11px] text-rose-800 dark:text-rose-200 flex items-center gap-2 shrink-0">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span className="flex-1 truncate">{saveError.message}</span>
                {saveError.retryable && (
                  <button
                    type="button"
                    onClick={() => handleSave()}
                    disabled={isSaving}
                    className="px-2 py-0.5 rounded bg-rose-600 text-white font-semibold disabled:opacity-50"
                  >
                    重试
                  </button>
                )}
              </div>
            )}
            <div
              className={`h-full grid divide-y lg:divide-y-0 lg:divide-x divide-neutral-200 dark:divide-neutral-800 ${
                editorMode === 'split'
                  ? 'grid-cols-1 lg:grid-cols-2'
                  : 'grid-cols-1'
              }`}
            >
                {(editorMode === 'split' || editorMode === 'edit') && (
                  <textarea
                    ref={fullscreenTextareaRef}
                    value={rawMarkdown}
                    onChange={e => handleMarkdownChange(e.target.value)}
                    onPaste={handlePaste}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    placeholder="在此沉浸专注编写 Markdown 正文..."
                    className="w-full h-full p-8 text-base font-mono leading-relaxed bg-transparent text-neutral-900 dark:text-neutral-100 outline-none resize-none"
                    spellCheck={false}
                    autoFocus
                  />
                )}

                {(editorMode === 'split' || editorMode === 'preview') && (
                  <div className="p-8 sm:p-12 overflow-y-auto h-full bg-white dark:bg-neutral-900">
                    <div
                      ref={fullscreenPreviewRef}
                      className="markdown-body max-w-3xl mx-auto"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(rawMarkdown) }}
                    />
                  </div>
                )}
              </div>
          </div>
        </div>
      )}

      {/* Interactive Tag Selection & Retrieval Modal */}
      {isTagModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-fade-in">
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
            
            {/* Modal Header */}
            <div className="p-4 sm:p-5 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400">
                  <TagIcon className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-neutral-900 dark:text-neutral-100">
                    选择知识标签 (Tags)
                  </h3>
                  <p className="text-xs text-neutral-500">
                    为文章关联知识标签，支持按关键词实时检索与点选
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  setIsTagModalOpen(false);
                  setTagSearchQuery('');
                }}
                className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Search Input Bar */}
            <div className="p-4 border-b border-neutral-100 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-950/40 space-y-2.5">
              <div className="relative">
                <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  autoFocus
                  value={tagSearchQuery}
                  onChange={e => setTagSearchQuery(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const clean = tagSearchQuery.trim().replace(/^#/, '');
                      if (clean) {
                        handleAddTag(clean);
                        setTagSearchQuery('');
                      }
                    }
                  }}
                  placeholder="检索已有标签，或输入新标签按回车..."
                  className="w-full pl-9 pr-8 py-2 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl text-xs outline-none focus:border-neutral-900 dark:focus:border-neutral-100 transition-colors text-neutral-900 dark:text-neutral-100"
                />
                {tagSearchQuery && (
                  <button
                    type="button"
                    onClick={() => setTagSearchQuery('')}
                    className="absolute right-2.5 top-2.5 text-neutral-400 hover:text-neutral-600 text-xs"
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* Quick Create Prompt if query doesn't match an existing tag */}
              {tagSearchQuery.trim() &&
                !availableTagsList.some(
                  t => t.name.toLowerCase() === tagSearchQuery.trim().toLowerCase().replace(/^#/, '')
                ) && (
                  <div className="flex items-center justify-between text-xs bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 rounded-xl px-3 py-2 animate-fade-in">
                    <span className="text-emerald-800 dark:text-emerald-300">
                      知识库中尚未收录「#{tagSearchQuery.trim().replace(/^#/, '')}」
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const clean = tagSearchQuery.trim().replace(/^#/, '');
                        if (clean) {
                          handleAddTag(clean);
                          setTagSearchQuery('');
                        }
                      }}
                      className="px-2.5 py-1 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors flex items-center gap-1 shadow-2xs"
                    >
                      <span>+ 创建并关联</span>
                    </button>
                  </div>
                )}
            </div>

            {/* Tags Selection Area */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
              {/* Currently Selected Section */}
              {selectedTags.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-neutral-500">
                      已选标签 ({selectedTags.length}) · 点击可反选移除
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectedTags([])}
                      className="text-[11px] text-neutral-400 hover:text-rose-600 transition-colors"
                    >
                      清空已选
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedTags.map(tag => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => handleRemoveTag(tag)}
                        className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 font-mono text-xs font-medium hover:opacity-85 transition-opacity shadow-2xs"
                        title="点击取消选择"
                      >
                        <Check className="w-3.5 h-3.5 shrink-0" />
                        <span>#{tag}</span>
                        <span className="text-neutral-400 dark:text-neutral-500 ml-0.5">×</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* All / Filtered Tags Section */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-neutral-500">
                    {tagSearchQuery.trim()
                      ? `检索结果 (${filteredTags.length})`
                      : `知识库常用标签 (${filteredTags.length})`}
                  </span>
                </div>

                {filteredTags.length === 0 ? (
                  <div className="py-8 text-center text-xs text-neutral-400">
                    未找到包含「{tagSearchQuery}」的标签，按回车可直接新建
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2 max-h-[260px] overflow-y-auto pr-1">
                    {filteredTags.map(t => {
                      const isSelected = selectedTags.includes(t.name);
                      return (
                        <button
                          key={t.name}
                          type="button"
                          onClick={() => handleToggleTag(t.name)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono transition-all ${
                            isSelected
                              ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 font-semibold shadow-2xs'
                              : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700'
                          }`}
                        >
                          {isSelected && <Check className="w-3.5 h-3.5 shrink-0" />}
                          <span>#{t.name}</span>
                          {t.count !== undefined && t.count > 0 && (
                            <span
                              className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                                isSelected
                                  ? 'bg-neutral-800 dark:bg-neutral-200 text-white dark:text-neutral-900'
                                  : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400'
                              }`}
                            >
                              {t.count}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-950/40 flex items-center justify-between">
              <span className="text-xs text-neutral-500 font-mono">
                已关联 {selectedTags.length} 个知识标签
              </span>
              <button
                type="button"
                onClick={() => {
                  setIsTagModalOpen(false);
                  setTagSearchQuery('');
                }}
                className="px-4 py-1.5 text-xs font-semibold bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 rounded-lg hover:opacity-90 shadow-2xs transition-opacity"
              >
                完成选择
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Version History Modal */}
      {showVersionModal && initialDoc && (
        <VersionHistoryModal
          isOpen={showVersionModal}
          onClose={() => setShowVersionModal(false)}
          doc={initialDoc}
          onReverted={updated => {
            const { frontmatter, body } = parseFrontmatter(updated.rawMarkdown);
            if (frontmatter.title) setTitle(frontmatter.title);
            if (frontmatter.category) setCategory(frontmatter.category);
            if (Array.isArray(frontmatter.tags)) setSelectedTags(frontmatter.tags);
            if (frontmatter.visibility) setVisibility(frontmatter.visibility as DocVisibility);
            if (frontmatter.status) setStatus(frontmatter.status as DocStatus);
            if (frontmatter.author) setAuthor(frontmatter.author);
            setRawMarkdown(body.trimStart());
            setShowVersionModal(false);
          }}
        />
      )}

      {/* Attachment Manager Modal */}
      {showAttachmentModal && (
        <AttachmentManager
          isOpen={showAttachmentModal}
          onClose={() => setShowAttachmentModal(false)}
          docId={docId}
          onInsertMarkdown={snippet => {
            insertText(snippet + '\n\n');
          }}
        />
      )}

      {/* Floating Upload Notification Toast */}
      {uploadToast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 shadow-2xl border border-neutral-700 dark:border-neutral-200 text-xs font-medium animate-fade-in">
          {isUploadingFile ? (
            <div className="w-4 h-4 border-2 border-white/30 dark:border-neutral-900/30 border-t-white dark:border-t-neutral-900 rounded-full animate-spin shrink-0" />
          ) : (
            <Check className="w-4 h-4 text-emerald-400 dark:text-emerald-600 shrink-0" />
          )}
          <span>{uploadToast}</span>
        </div>
      )}

    </div>
  );
};
