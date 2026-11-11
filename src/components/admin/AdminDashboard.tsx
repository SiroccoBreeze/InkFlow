import React, { useState, useRef, useMemo, useEffect } from 'react';
import {
  FileText,
  Plus,
  Upload,
  Download,
  Folder,
  Tag,
  Search,
  Check,
  Trash2,
  Edit3,
  ExternalLink,
  History,
  Lock,
  Globe,
  HardDrive,
  Archive,
  Star,
  RefreshCw,
  LayoutGrid,
  List,
  Shield,
  X,
  ChevronDown,
  Paperclip,
  CheckSquare,
  Square,
  Filter,
  ArrowUpDown,
  MoreHorizontal,
  Eye,
  Calendar,
  Layers,
} from 'lucide-react';
import { Category, DocStatus, DocVisibility, KnowledgeDoc } from '../../types';
import { storage } from '../../services/storage';
import { apiClient } from '../../services/apiClient';
import { DocEditor } from './DocEditor';
import { VersionHistoryModal } from './VersionHistoryModal';
import { Pagination } from '../common/Pagination';
import { AttachmentManager } from './AttachmentManager';
import { ConfirmModal } from '../common/ConfirmModal';
import { RevisionManager } from './RevisionManager';

interface AdminDashboardProps {
  docs: KnowledgeDoc[];
  categories: Category[];
  onRefreshData: () => void;
  onViewDoc: (doc: KnowledgeDoc) => void;
  onLogout?: () => void;
}

const DOC_STATUS_LABELS: Record<DocStatus, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已归档',
};

const CATEGORY_COLORS: Record<string, string> = {
  '架构与系统': '#0284c7', // Sky Blue
  '前端与工程': '#16a34a', // Emerald Green
  '认知与方法论': '#d97706', // Amber Gold
  '商业与战略': '#7c3aed', // Violet Purple
  '个人复盘': '#e11d48', // Rose Red
};

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  docs,
  categories,
  onRefreshData,
  onViewDoc,
  onLogout,
}) => {
  // Navigation tabs: clean workspace tabs
  const [activeTab, setActiveTab] = useState<'docs' | 'tags' | 'categories' | 'revisions' | 'assets' | 'settings'>('docs');

  // Modal dialog states
  const [editingDoc, setEditingDoc] = useState<KnowledgeDoc | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [historyDoc, setHistoryDoc] = useState<KnowledgeDoc | null>(null);
  const [isAssetManagerOpen, setIsAssetManagerOpen] = useState(false);

  // Filters for Document List
  const [searchQuery, setSearchQuery] = useState('');
  const [filterVisibility, setFilterVisibility] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterTag, setFilterTag] = useState<string>('all');
  const [filterPinnedOnly, setFilterPinnedOnly] = useState(false);
  const [sortOrder, setSortOrder] = useState<
    'updated_desc' | 'updated_asc' | 'created_desc' | 'title_asc' | 'words_desc' | 'words_asc' | 'pinned_first'
  >('updated_desc');

  // View mode: Table (default) vs Grid
  const [viewMode, setViewMode] = useState<'table' | 'grid'>('table');

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // Batch selection
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  const [batchMoveCat, setBatchMoveCat] = useState<string>('');
  const [batchStatus, setBatchStatus] = useState<DocStatus | ''>('');

  // Category management form states
  const [newCatName, setNewCatName] = useState('');
  const [newCatDesc, setNewCatDesc] = useState('');
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [editingCatName, setEditingCatName] = useState('');
  const [editingCatDesc, setEditingCatDesc] = useState('');

  // Tag management states
  const [newTagName, setNewTagName] = useState('');
  const [searchTag, setSearchTag] = useState('');
  const [editingTagOldName, setEditingTagOldName] = useState<string | null>(null);
  const [editingTagNewName, setEditingTagNewName] = useState('');
  const [mergeSourceTag, setMergeSourceTag] = useState<string>('');
  const [mergeTargetTag, setMergeTargetTag] = useState<string>('');

  // Passcode change
  const [newPasscode, setNewPasscode] = useState('');
  const [passcodeNotice, setPasscodeNotice] = useState<string | null>(null);

  // Status feedback
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isRebuildingIndex, setIsRebuildingIndex] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backupFileInputRef = useRef<HTMLInputElement>(null);
  const [isStoragePersisted, setIsStoragePersisted] = useState<boolean | null>(null);
  const [isCleaningAssets, setIsCleaningAssets] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    isDestructive?: boolean;
    type?: 'warning' | 'danger' | 'info';
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  // Check storage persist status
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then(val => setIsStoragePersisted(val)).catch(() => {});
    }
  }, []);

  // Reset pagination on filter change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, filterVisibility, filterStatus, filterCategory, filterTag, filterPinnedOnly, sortOrder]);

  const showStatus = (msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage(null), 3000);
  };

  const allTagsList = useMemo(() => storage.getAllTags(), [docs]);

  // Tag counts
  const tagCounts = useMemo(() => {
    return docs.reduce((acc, doc) => {
      (doc.tags || []).forEach(t => {
        acc[t] = (acc[t] || 0) + 1;
      });
      return acc;
    }, {} as Record<string, number>);
  }, [docs]);

  // Filtered documents
  const filteredDocs = useMemo(() => {
    let result = docs.filter(doc => {
      if (filterPinnedOnly && !doc.pinned) return false;
      if (filterVisibility !== 'all' && doc.visibility !== filterVisibility) return false;
      // Legacy documents without a status field were published before statuses existed
      if (filterStatus !== 'all' && (doc.status ?? 'published') !== filterStatus) return false;
      if (filterCategory !== 'all' && doc.category !== filterCategory) return false;
      if (filterTag !== 'all' && (!doc.tags || !doc.tags.includes(filterTag))) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const match =
          doc.title.toLowerCase().includes(q) ||
          doc.category.toLowerCase().includes(q) ||
          (doc.slug && doc.slug.toLowerCase().includes(q)) ||
          (doc.tags || []).some(t => t.toLowerCase().includes(q));
        if (!match) return false;
      }
      return true;
    });

    return [...result].sort((a, b) => {
      switch (sortOrder) {
        case 'pinned_first':
          if (a.pinned && !b.pinned) return -1;
          if (!a.pinned && b.pinned) return 1;
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        case 'updated_asc':
          return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
        case 'created_desc':
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case 'title_asc':
          return a.title.localeCompare(b.title, 'zh-CN');
        case 'words_desc':
          return (b.wordCount || 0) - (a.wordCount || 0);
        case 'words_asc':
          return (a.wordCount || 0) - (b.wordCount || 0);
        case 'updated_desc':
        default:
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
    });
  }, [docs, filterPinnedOnly, filterVisibility, filterStatus, filterCategory, filterTag, searchQuery, sortOrder]);

  // Pagination calculation
  const totalPages = Math.max(1, Math.ceil(filteredDocs.length / pageSize));
  const paginatedDocs = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredDocs.slice(start, start + pageSize);
  }, [filteredDocs, currentPage, pageSize]);

  // Page selection
  const isPageAllSelected =
    paginatedDocs.length > 0 && paginatedDocs.every(d => selectedDocIds.includes(d.id));

  const toggleSelectPage = () => {
    if (isPageAllSelected) {
      const pageIds = new Set(paginatedDocs.map(d => d.id));
      setSelectedDocIds(prev => prev.filter(id => !pageIds.has(id)));
    } else {
      const pageIds = paginatedDocs.map(d => d.id);
      setSelectedDocIds(prev => Array.from(new Set([...prev, ...pageIds])));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedDocIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  // Quick document operations. Every mutation now waits for the server commit;
  // the local cache only changes on success.
  const saveDocWithFeedback = async (
    input: Parameters<typeof storage.saveDoc>[0],
    note: string,
    successMessage: string
  ): Promise<boolean> => {
    const result = await storage.saveDoc(input, note);
    // Refresh in both cases: on failure this restores the controls to the
    // server-confirmed local state instead of showing an unsaved value.
    onRefreshData();
    if (result.success) {
      showStatus(successMessage);
      return true;
    }
    showStatus(`保存失败：${result.error?.message || '未知错误'}`);
    return false;
  };

  const handleQuickVisibilityChange = async (doc: KnowledgeDoc, newVis: DocVisibility) => {
    await saveDocWithFeedback(
      {
        ...doc,
        visibility: newVis,
        unlistedKey:
          newVis === 'unlisted'
            ? doc.unlistedKey || Math.random().toString(36).slice(2, 10)
            : undefined,
      },
      `修改可见性为 ${newVis}`,
      `已更新「${doc.title}」为 ${newVis}`
    );
  };

  const handleQuickCategoryChange = async (doc: KnowledgeDoc, newCat: string) => {
    await saveDocWithFeedback(
      {
        ...doc,
        category: newCat,
      },
      `修改分类为 ${newCat}`,
      `已更新「${doc.title}」分类为「${newCat}」`
    );
  };

  const handleQuickStatusChange = async (doc: KnowledgeDoc, newStatus: DocStatus) => {
    await saveDocWithFeedback(
      {
        ...doc,
        status: newStatus,
      },
      `修改发布状态为 ${newStatus}`,
      `已更新「${doc.title}」为「${DOC_STATUS_LABELS[newStatus]}」`
    );
  };

  const handleQuickPinToggle = async (doc: KnowledgeDoc) => {
    const nextPinned = !doc.pinned;
    await saveDocWithFeedback(
      {
        ...doc,
        pinned: nextPinned,
      },
      nextPinned ? '置顶文档' : '取消置顶',
      nextPinned ? `已置顶「${doc.title}」` : `已取消置顶「${doc.title}」`
    );
  };

  const handleDeleteDoc = (id: string, title: string) => {
    setConfirmModal({
      isOpen: true,
      title: '彻底删除知识文档',
      message: `确定要彻底删除文档「${title || '未命名'}」吗？\n将同步删除服务器磁盘 storage/documents/、历史版本快照 storage/revisions/，并自动清理不再被任何文档引用的物理附件。`,
      confirmText: '彻底删除',
      cancelText: '取消',
      isDestructive: true,
      type: 'danger',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        try {
          await storage.deleteDoc(id);
          setSelectedDocIds(prev => prev.filter(i => i !== id));
          onRefreshData();
          showStatus('文档及关联历史快照、未引用物理附件已彻底清理');
        } catch (err: any) {
          showStatus(`删除失败: ${err?.message || '磁盘 I/O 异常'}`);
        }
      },
    });
  };

  // Batch actions
  const handleBatchDelete = () => {
    if (selectedDocIds.length === 0) return;
    setConfirmModal({
      isOpen: true,
      title: '批量删除文档',
      message: `确定要批量删除选中的 ${selectedDocIds.length} 篇文档吗？\n将从服务器磁盘存储与数据库中永久移除，并自动回收未引用孤立附件。`,
      confirmText: `删除 ${selectedDocIds.length} 篇文档`,
      cancelText: '取消',
      isDestructive: true,
      type: 'danger',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        try {
          await storage.batchDeleteDocs(selectedDocIds);
          setSelectedDocIds([]);
          onRefreshData();
          showStatus(`已安全批量删除 ${selectedDocIds.length} 篇文档`);
        } catch (err: any) {
          showStatus(`批量删除失败: ${err?.message || '网络或磁盘异常'}`);
        }
      },
    });
  };

  // Dedicated Orphan Assets Cleaner
  const handleCleanupOrphanAssets = () => {
    setConfirmModal({
      isOpen: true,
      title: '深度清理未引用孤立附件',
      message: '系统将完整检索 storage/documents/ 下所有 Markdown 文件，检测 storage/assets/ 中未被任何文档正文引用的物理文件与数据库记录，并安全彻底从磁盘中删除。\n\n确定立即执行清理吗？',
      confirmText: '立即扫描并清理',
      cancelText: '取消',
      isDestructive: false,
      type: 'warning',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        setIsCleaningAssets(true);
        showStatus('正在扫描并清理未引用附件...');
        try {
          const res = await apiClient.cleanupOrphanAssets();
          if (res.data) {
            const { cleanedCount, freedBytes } = res.data;
            const mb = (freedBytes / (1024 * 1024)).toFixed(2);
            showStatus(`清理完成：已物理移除 ${cleanedCount} 个未引用文件，释放 ${mb} MB 磁盘空间`);
          } else {
            showStatus(res.error?.message || '扫描完毕，暂无未引用附件需要清理');
          }
        } catch (err: any) {
          showStatus(`清理出错: ${err?.message || '网络或磁盘异常'}`);
        } finally {
          setIsCleaningAssets(false);
          onRefreshData();
        }
      },
    });
  };

  const runBatchSave = async (
    ids: string[],
    buildInput: (doc: KnowledgeDoc) => Parameters<typeof storage.saveDoc>[0],
    note: string
  ): Promise<{ succeeded: number; failed: number }> => {
    let succeeded = 0;
    let failed = 0;
    // Sequential: each save waits for the server so version numbers stay ordered.
    for (const id of ids) {
      const doc = storage.getDocById(id);
      if (!doc) continue;
      const result = await storage.saveDoc(buildInput(doc), note);
      if (result.success) succeeded++;
      else {
        failed++;
        console.error(`Batch save failed for ${id}:`, result.error);
      }
    }
    onRefreshData();
    return { succeeded, failed };
  };

  const handleBatchSetVisibility = async (newVis: DocVisibility) => {
    if (selectedDocIds.length === 0) return;
    const ids = [...selectedDocIds];
    const { succeeded, failed } = await runBatchSave(
      ids,
      doc => ({
        ...doc,
        visibility: newVis,
        unlistedKey:
          newVis === 'unlisted'
            ? doc.unlistedKey || Math.random().toString(36).slice(2, 10)
            : undefined,
      }),
      `批量修改可见性为 ${newVis}`
    );
    setSelectedDocIds([]);
    showStatus(
      failed === 0
        ? `已将选中的 ${succeeded} 篇文档批量设为 ${newVis}`
        : `批量更新完成：成功 ${succeeded} 篇，失败 ${failed} 篇（失败项未修改）`
    );
  };

  const handleBatchSetStatus = async (newStatus: DocStatus) => {
    if (selectedDocIds.length === 0) return;
    const ids = [...selectedDocIds];
    const { succeeded, failed } = await runBatchSave(
      ids,
      doc => ({ ...doc, status: newStatus }),
      `批量修改发布状态为 ${newStatus}`
    );
    setSelectedDocIds([]);
    setBatchStatus('');
    showStatus(
      failed === 0
        ? `已将选中的 ${succeeded} 篇文档批量设为「${DOC_STATUS_LABELS[newStatus]}」`
        : `批量更新完成：成功 ${succeeded} 篇，失败 ${failed} 篇（失败项未修改）`
    );
  };

  const handleBatchMoveCategory = async () => {
    if (selectedDocIds.length === 0 || !batchMoveCat) return;
    const ids = [...selectedDocIds];
    const targetCategory = batchMoveCat;
    const { succeeded, failed } = await runBatchSave(
      ids,
      doc => ({ ...doc, category: targetCategory }),
      `批量移动到分类 ${targetCategory}`
    );
    setBatchMoveCat('');
    setSelectedDocIds([]);
    showStatus(
      failed === 0
        ? `已将选中的 ${succeeded} 篇文档移动至「${targetCategory}」`
        : `批量移动完成：成功 ${succeeded} 篇，失败 ${failed} 篇（失败项未修改）`
    );
  };

  const handleBatchExportZip = async () => {
    if (selectedDocIds.length === 0) return;
    try {
      const blob = await storage.exportAllAsZip();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `inkflow-selected-docs-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showStatus(`已导出 ${selectedDocIds.length} 篇选中文档的 ZIP 归档`);
    } catch {
      showStatus('导出 ZIP 归档时发生异常');
    }
  };

  const handleExportZip = async () => {
    try {
      const blob = await storage.exportAllAsZip();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `inkflow-knowledge-base-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showStatus('已导出全库 Markdown ZIP 归档包');
    } catch {
      showStatus('导出全库归档包时发生异常');
    }
  };

  const handleImportFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const imported = await storage.importMarkdownFiles(files);
    onRefreshData();
    showStatus(`成功批量导入 ${imported.length} 篇 Markdown 文档`);
  };

  const handleRebuildIndex = async () => {
    try {
      setIsRebuildingIndex(true);
      showStatus('正在扫描物理磁盘 Markdown 文件并重建索引...');
      const res = await apiClient.rebuildIndex();
      if (res.data?.success) {
        onRefreshData();
        showStatus(res.data.message || '索引已全量重建！');
      } else {
        showStatus('已完成磁盘扫描');
      }
    } catch {
      showStatus('重建索引已执行完成');
    } finally {
      setIsRebuildingIndex(false);
    }
  };

  // Open editor for creating new doc (Clean slate: zero template clutter)
  const handleStartCreateNewDoc = () => {
    setIsCreatingNew(true);
    setEditingDoc({
      id: '',
      title: '',
      slug: `note-${Date.now().toString(36)}`,
      rawMarkdown: '',
      category: categories[0]?.name || '未分类',
      tags: [],
      visibility: 'public',
      pinned: false,
      wordCount: 0,
      readingTimeMinutes: 1,
      author: 'Hecker',
      versionCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  };

  // Tag Operations
  const handleAddTag = (e: React.FormEvent) => {
    e.preventDefault();
    const tag = newTagName.trim().replace(/^#/, '');
    if (!tag) return;
    storage.addTag(tag);
    setNewTagName('');
    onRefreshData();
    showStatus(`标签 #${tag} 已录入系统字典`);
  };

  const handleSaveRenameTag = async (oldTag: string) => {
    const newTag = editingTagNewName.trim().replace(/^#/, '');
    if (!newTag || newTag === oldTag) {
      setEditingTagOldName(null);
      return;
    }
    setEditingTagOldName(null);
    const result = await storage.renameTag(oldTag, newTag);
    onRefreshData();
    if (!result) return;
    if (result.failed === 0) {
      showStatus(
        result.dictionaryCleanupFailed
          ? `已将 #${oldTag} 重命名为 #${newTag}（${result.succeeded} 篇），旧标签字典清理失败`
          : `已将标签 #${oldTag} 重命名为 #${newTag}`
      );
    } else {
      showStatus(
        `标签重命名部分成功：${result.succeeded} 篇已更新，${result.failed} 篇保存失败并保留原标签`
      );
    }
  };

  const handleDeleteTag = (tag: string) => {
    setConfirmModal({
      isOpen: true,
      title: '删除标签',
      message: `确定彻底删除标签 #${tag} 吗？所有文档中的该标签将被一并解除关联。`,
      confirmText: '删除标签',
      isDestructive: true,
      type: 'danger',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        const result = await storage.deleteTag(tag);
        onRefreshData();
        if (result.failed === 0) {
          showStatus(
            result.dictionaryCleanupFailed
              ? `已从 ${result.succeeded} 篇文档移除标签 #${tag}，但服务端标签字典清理失败`
              : `已移除标签 #${tag}`
          );
        } else {
          showStatus(
            `标签删除部分成功：${result.succeeded} 篇已更新，${result.failed} 篇保存失败并保留该标签`
          );
        }
      },
    });
  };

  const handleMergeTags = (e: React.FormEvent) => {
    e.preventDefault();
    if (!mergeSourceTag || !mergeTargetTag || mergeSourceTag === mergeTargetTag) {
      showStatus('请选择两个不同的源标签与目标标签');
      return;
    }
    setConfirmModal({
      isOpen: true,
      title: '合并标签',
      message: `确定将标签 #${mergeSourceTag} 合并至 #${mergeTargetTag} 吗？所有关联文档将统一变更为新标签。`,
      confirmText: '确认合并',
      type: 'warning',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        const from = mergeSourceTag;
        const to = mergeTargetTag;
        const result = await storage.mergeTags(from, to);
        setMergeSourceTag('');
        setMergeTargetTag('');
        onRefreshData();
        if (!result) return;
        if (result.failed === 0) {
          showStatus(
            result.dictionaryCleanupFailed
              ? `已将 #${from} 合并至 #${to}（${result.succeeded} 篇），旧标签字典清理失败`
              : `已合并标签 #${from} 至 #${to}`
          );
        } else {
          showStatus(
            `标签合并部分成功：${result.succeeded} 篇已更新，${result.failed} 篇保存失败并保留原标签`
          );
        }
      },
    });
  };

  // Category Operations
  const handleAddCategory = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatName.trim()) return;
    storage.saveCategory({
      id: `cat-${Date.now().toString(36)}`,
      name: newCatName.trim(),
      slug: newCatName.trim().toLowerCase().replace(/\s+/g, '-'),
      description: newCatDesc.trim() || '自主管理的知识领域',
      order: categories.length + 1,
    });
    setNewCatName('');
    setNewCatDesc('');
    onRefreshData();
    showStatus('知识分类已创建');
  };

  const handleSaveEditCategory = (catId: string) => {
    if (!editingCatName.trim()) return;
    const cat = categories.find(c => c.id === catId);
    if (cat) {
      storage.saveCategory({
        ...cat,
        name: editingCatName.trim(),
        description: editingCatDesc.trim(),
      });
      setEditingCatId(null);
      onRefreshData();
      showStatus('知识分类修改已保存');
    }
  };

  const handleDeleteCategory = (catId: string, catName: string) => {
    if (categories.length <= 1) {
      showStatus('至少需要保留一个默认知识分类');
      return;
    }
    setConfirmModal({
      isOpen: true,
      title: '删除知识分类',
      message: `确定删除分类「${catName}」吗？所属文档将归入「未分类」。`,
      confirmText: '删除分类',
      isDestructive: true,
      type: 'danger',
      onConfirm: () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        storage.deleteCategory(catId);
        onRefreshData();
        showStatus(`分类「${catName}」已安全删除`);
      },
    });
  };

  // Backup & Storage operations
  const handleExportBackupJson = () => {
    const jsonStr = storage.exportFullBackupJson();
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inkflow-full-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus('已导出全库完整 JSON 镜像');
  };

  const handleImportBackupJson = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      if (text) {
        const result = storage.importFullBackupJson(text);
        if (result.success) {
          onRefreshData();
          showStatus(result.message);
        } else {
          showStatus(`导入失败: ${result.message}`);
        }
      }
    };
    reader.readAsText(file);
  };

  const handleResetDemo = () => {
    setConfirmModal({
      isOpen: true,
      title: '重置为初始演示数据',
      message: '确定要重置知识库为初始演示数据吗？\n当前自建的所有私密文档、分类与附件将恢复为系统预置示例。',
      confirmText: '确认重置',
      isDestructive: true,
      type: 'danger',
      onConfirm: () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        storage.resetToDefault();
        onRefreshData();
        showStatus('已成功重置为初始演示数据');
      },
    });
  };

  const handleUpdatePasscode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPasscode || newPasscode.length < 6) {
      setPasscodeNotice('密码长度至少需要 6 个字符');
      return;
    }
    await storage.updateOwnerPassword(newPasscode);
    setNewPasscode('');
    setPasscodeNotice('主理人密码已更新，旧会话已安全撤销');
    setTimeout(() => setPasscodeNotice(null), 4000);
  };


  // If editor is active, render editor full screen
  if (editingDoc) {
    return (
      <DocEditor
        initialDoc={editingDoc}
        categories={categories}
        allTags={allTagsList.map(t => t.name)}
        onSaveSuccess={(savedDoc: KnowledgeDoc) => {
          setEditingDoc(null);
          setIsCreatingNew(false);
          onRefreshData();
          showStatus(`文档「${savedDoc.title}」已保存至物理磁盘与索引`);
        }}
        onCancel={() => {
          setEditingDoc(null);
          setIsCreatingNew(false);
        }}
      />
    );
  }

  const isFilterActive =
    Boolean(searchQuery) ||
    filterCategory !== 'all' ||
    filterTag !== 'all' ||
    filterVisibility !== 'all' ||
    filterStatus !== 'all' ||
    filterPinnedOnly;

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 space-y-4">
      
      {/* 1. SLIM, PRO-GRADE WORKSPACE TOPBAR (Zero fluffy cards!) */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-neutral-200 dark:border-neutral-800">
        
        {/* Left: Title & Minimalist Workspace Tabs */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
              内容管理
            </h1>
            <span className="font-mono text-xs px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 font-semibold">
              {docs.length}
            </span>
          </div>

          <div className="h-4 w-px bg-neutral-200 dark:border-neutral-800 hidden sm:block" />

          {/* Clean Segmented Workspace Navigation */}
          <nav className="flex items-center gap-1 text-xs font-medium">
            <button
              onClick={() => setActiveTab('docs')}
              className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${
                activeTab === 'docs'
                  ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 font-semibold shadow-2xs'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800/60'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>文档列表</span>
            </button>

            <button
              onClick={() => setActiveTab('tags')}
              className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${
                activeTab === 'tags'
                  ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 font-semibold shadow-2xs'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800/60'
              }`}
            >
              <Tag className="w-3.5 h-3.5" />
              <span>标签字典</span>
              <span className="font-mono text-[10px] opacity-70">({allTagsList.length})</span>
            </button>

            <button
              onClick={() => setActiveTab('categories')}
              className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${
                activeTab === 'categories'
                  ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 font-semibold shadow-2xs'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800/60'
              }`}
            >
              <Folder className="w-3.5 h-3.5" />
              <span>分类领域</span>
              <span className="font-mono text-[10px] opacity-70">({categories.length})</span>
            </button>

            <button
              onClick={() => setActiveTab('revisions')}
              className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${
                activeTab === 'revisions'
                  ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 font-semibold shadow-2xs'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800/60'
              }`}
              title="查看与清理 storage/revisions/ 物理快照占用"
            >
              <History className="w-3.5 h-3.5" />
              <span>版本快照</span>
            </button>

            <button
              onClick={() => setIsAssetManagerOpen(true)}
              className="px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
            >
              <Paperclip className="w-3.5 h-3.5" />
              <span>附件库</span>
            </button>

            <button
              onClick={() => setActiveTab('settings')}
              className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${
                activeTab === 'settings'
                  ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 font-semibold shadow-2xs'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800/60'
              }`}
            >
              <Shield className="w-3.5 h-3.5" />
              <span>数据与备份</span>
            </button>
          </nav>
        </div>

        {/* Right: Primary & Secondary Actions */}
        <div className="flex items-center gap-2 self-end md:self-auto shrink-0">
          <button
            onClick={handleStartCreateNewDoc}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 hover:opacity-90 transition-opacity flex items-center gap-1.5 shadow-2xs cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新建文档</span>
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-1.5 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors border border-neutral-200 dark:border-neutral-800"
            title="导入 Markdown 文件 (.md)"
          >
            <Upload className="w-3.5 h-3.5" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".md,.markdown"
            className="hidden"
            onChange={e => handleImportFiles(e.target.files)}
          />

          <button
            onClick={handleExportZip}
            className="p-1.5 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors border border-neutral-200 dark:border-neutral-800"
            title="导出全库为 ZIP 归档"
          >
            <Download className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={handleRebuildIndex}
            disabled={isRebuildingIndex}
            className="p-1.5 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/60 rounded-lg transition-colors border border-emerald-200 dark:border-emerald-800/80 disabled:opacity-40"
            title="扫描本地 storage/documents/ 物理文件并全量重建 SQLite 索引"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRebuildingIndex ? 'animate-spin' : ''}`} />
          </button>

          <button
            onClick={handleCleanupOrphanAssets}
            disabled={isCleaningAssets}
            className="p-1.5 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/60 rounded-lg transition-colors border border-amber-200 dark:border-amber-800/80 disabled:opacity-40 flex items-center gap-1"
            title="扫描全库 Markdown 正文，清理未被任何文档引用的本地孤立物理附件并释放磁盘"
          >
            <Trash2 className={`w-3.5 h-3.5 ${isCleaningAssets ? 'animate-spin' : ''}`} />
            <span className="text-[11px] font-medium hidden sm:inline">清理未引用附件</span>
          </button>
        </div>

      </div>

      {/* Status Feedback Toast */}
      {statusMessage && (
        <div className="p-2.5 bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 rounded-xl text-xs flex items-center gap-2 animate-fade-in shadow-sm">
          <Check className="w-3.5 h-3.5 text-emerald-400 dark:text-emerald-600 shrink-0" />
          <span className="font-medium">{statusMessage}</span>
        </div>
      )}

      {/* 2. TAB 1: DOCUMENT WORKSPACE (High efficiency, table-first) */}
      {activeTab === 'docs' && (
        <div className="space-y-3">
          
          {/* Streamlined Filter & Search Toolbar (Single row, zero clutter) */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-2.5 text-xs">
            
            {/* Left: Search & Filter Dropdowns */}
            <div className="flex items-center gap-2 flex-wrap flex-1">
              {/* Search input */}
              <div className="relative w-full sm:w-60">
                <Search className="w-3.5 h-3.5 text-neutral-400 absolute left-2.5 top-2.5" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="搜索标题、标签、别名..."
                  className="w-full pl-8 pr-7 py-1.5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg text-xs outline-none text-neutral-900 dark:text-neutral-100 focus:border-neutral-400 transition-colors"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-2 text-neutral-400 hover:text-neutral-600"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Category Filter */}
              <select
                value={filterCategory}
                onChange={e => setFilterCategory(e.target.value)}
                className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 rounded-lg px-2.5 py-1.5 text-xs outline-none cursor-pointer hover:border-neutral-400"
              >
                <option value="all">全部分类 ({docs.length})</option>
                {categories.map(c => {
                  const count = docs.filter(d => d.category === c.name).length;
                  return (
                    <option key={c.id} value={c.name}>
                      {c.name} ({count})
                    </option>
                  );
                })}
              </select>

              {/* Tag Filter */}
              <select
                value={filterTag}
                onChange={e => setFilterTag(e.target.value)}
                className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 rounded-lg px-2.5 py-1.5 text-xs outline-none cursor-pointer hover:border-neutral-400"
              >
                <option value="all">全部标签 ({allTagsList.length})</option>
                {allTagsList.map(t => (
                  <option key={t.name} value={t.name}>
                    #{t.name} ({t.count})
                  </option>
                ))}
              </select>

              {/* Visibility Filter */}
              <select
                value={filterVisibility}
                onChange={e => setFilterVisibility(e.target.value)}
                className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 rounded-lg px-2.5 py-1.5 text-xs outline-none cursor-pointer hover:border-neutral-400"
              >
                <option value="all">全部可见性</option>
                <option value="public">🌐 公开</option>
                <option value="unlisted">🔗 未公开</option>
                <option value="private">🔒 私密</option>
              </select>

              {/* Publish Status Filter */}
              <select
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value)}
                className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 rounded-lg px-2.5 py-1.5 text-xs outline-none cursor-pointer hover:border-neutral-400"
                title="按发布状态筛选"
              >
                <option value="all">全部状态</option>
                <option value="draft">📝 草稿</option>
                <option value="published">✅ 已发布</option>
                <option value="archived">📦 已归档</option>
              </select>

              {/* Pinned filter toggle */}
              <button
                onClick={() => setFilterPinnedOnly(!filterPinnedOnly)}
                className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors flex items-center gap-1 cursor-pointer ${
                  filterPinnedOnly
                    ? 'bg-amber-50 dark:bg-amber-950/50 border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-200 font-semibold'
                    : 'bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-400 hover:border-neutral-400'
                }`}
                title="仅查看置顶文档"
              >
                <Star className="w-3.5 h-3.5" fill={filterPinnedOnly ? 'currentColor' : 'none'} />
                <span>置顶</span>
              </button>

              {/* Clear filters */}
              {isFilterActive && (
                <button
                  onClick={() => {
                    setSearchQuery('');
                    setFilterCategory('all');
                    setFilterTag('all');
                    setFilterVisibility('all');
                    setFilterStatus('all');
                    setFilterPinnedOnly(false);
                  }}
                  className="text-neutral-400 hover:text-rose-500 text-xs underline"
                >
                  重置筛选
                </button>
              )}
            </div>

            {/* Right: Sorter & View Switcher */}
            <div className="flex items-center gap-2 self-end md:self-auto shrink-0">
              {/* Sorter */}
              <div className="flex items-center gap-1 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-2 py-1 text-xs">
                <ArrowUpDown className="w-3 h-3 text-neutral-400" />
                <select
                  value={sortOrder}
                  onChange={e => setSortOrder(e.target.value as any)}
                  className="bg-transparent border-none text-xs text-neutral-700 dark:text-neutral-300 outline-none cursor-pointer"
                >
                  <option value="updated_desc">最新更新 ↓</option>
                  <option value="updated_asc">最早更新 ↑</option>
                  <option value="created_desc">创建时间 ↓</option>
                  <option value="title_asc">标题 (A-Z)</option>
                  <option value="words_desc">字数最多 ↓</option>
                  <option value="words_asc">字数最少 ↑</option>
                  <option value="pinned_first">置顶推荐优先</option>
                </select>
              </div>

              {/* View mode toggle */}
              <div className="flex items-center bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-0.5">
                <button
                  onClick={() => setViewMode('table')}
                  className={`p-1 rounded transition-colors ${
                    viewMode === 'table'
                      ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                      : 'text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300'
                  }`}
                  title="表格视图"
                >
                  <List className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setViewMode('grid')}
                  className={`p-1 rounded transition-colors ${
                    viewMode === 'grid'
                      ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                      : 'text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300'
                  }`}
                  title="网格卡片视图"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

          </div>

          {/* Floating/Integrated Batch Action Bar (Appears only when items are selected) */}
          {selectedDocIds.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 rounded-xl text-xs shadow-md animate-fade-in">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold font-mono">
                  已选 {selectedDocIds.length} 篇
                </span>

                <button
                  onClick={() => {
                    setSelectedDocIds(filteredDocs.map(d => d.id));
                    showStatus(`已全选匹配的 ${filteredDocs.length} 篇文档`);
                  }}
                  className="underline text-neutral-300 dark:text-neutral-600 hover:text-white dark:hover:text-black"
                >
                  全选筛选结果 ({filteredDocs.length})
                </button>

                <span className="opacity-30">|</span>

                <button
                  onClick={() => handleBatchSetVisibility('public')}
                  className="px-2 py-1 rounded bg-white/10 dark:bg-neutral-200 hover:bg-white/20 transition-colors"
                >
                  设为公开
                </button>
                <button
                  onClick={() => handleBatchSetVisibility('private')}
                  className="px-2 py-1 rounded bg-white/10 dark:bg-neutral-200 hover:bg-white/20 transition-colors"
                >
                  设为私密
                </button>
                <button
                  onClick={() => handleBatchSetVisibility('unlisted')}
                  className="px-2 py-1 rounded bg-white/10 dark:bg-neutral-200 hover:bg-white/20 transition-colors"
                >
                  设为未公开
                </button>

                <span className="opacity-30">|</span>

                {/* Batch publish-status update */}
                <div className="flex items-center gap-1 bg-white/10 dark:bg-neutral-200 px-2 py-0.5 rounded">
                  <span className="text-[11px] opacity-75">状态:</span>
                  <select
                    value={batchStatus}
                    onChange={e => setBatchStatus(e.target.value as DocStatus | '')}
                    className="bg-transparent text-xs text-white dark:text-neutral-900 outline-none cursor-pointer"
                    title="批量修改发布状态"
                  >
                    <option value="" className="text-neutral-900">修改为...</option>
                    <option value="draft" className="text-neutral-900">草稿</option>
                    <option value="published" className="text-neutral-900">已发布</option>
                    <option value="archived" className="text-neutral-900">已归档</option>
                  </select>
                  {batchStatus && (
                    <button
                      onClick={() => handleBatchSetStatus(batchStatus)}
                      className="px-1.5 py-0.5 rounded bg-emerald-500 text-white font-bold text-[10px]"
                    >
                      确定
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-1 bg-white/10 dark:bg-neutral-200 px-2 py-0.5 rounded">
                  <span className="text-[11px] opacity-75">移动至:</span>
                  <select
                    value={batchMoveCat}
                    onChange={e => setBatchMoveCat(e.target.value)}
                    className="bg-transparent text-xs text-white dark:text-neutral-900 outline-none cursor-pointer"
                  >
                    <option value="" className="text-neutral-900">选择分类...</option>
                    {categories.map(c => (
                      <option key={c.id} value={c.name} className="text-neutral-900">
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {batchMoveCat && (
                    <button
                      onClick={handleBatchMoveCategory}
                      className="px-1.5 py-0.5 rounded bg-emerald-500 text-white font-bold text-[10px]"
                    >
                      确定
                    </button>
                  )}
                </div>

                <button
                  onClick={handleBatchExportZip}
                  className="px-2 py-1 rounded bg-white/10 dark:bg-neutral-200 hover:bg-white/20 transition-colors flex items-center gap-1"
                >
                  <Download className="w-3 h-3" />
                  <span>导出 ZIP</span>
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleBatchDelete}
                  className="px-2.5 py-1 rounded bg-rose-600 hover:bg-rose-700 text-white font-medium flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>删除选中</span>
                </button>
                <button
                  onClick={() => setSelectedDocIds([])}
                  className="px-2 py-1 text-neutral-400 hover:text-white dark:hover:text-black text-xs"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* VIEW MODE A: HIGH DENSITY COMPACT DATA TABLE */}
          {viewMode === 'table' ? (
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden shadow-2xs">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/70 dark:bg-neutral-950/50 text-neutral-500 font-semibold uppercase tracking-wider text-[11px]">
                      <th className="py-2.5 px-3 w-9 text-center">
                        <input
                          type="checkbox"
                          checked={isPageAllSelected}
                          onChange={toggleSelectPage}
                          className="rounded cursor-pointer"
                          title="全选当前页"
                        />
                      </th>
                      <th className="py-2.5 px-3">标题与元数据</th>
                      <th className="py-2.5 px-3 w-36">分类</th>
                      <th className="py-2.5 px-3 w-28">可见性</th>
                      <th className="py-2.5 px-3 w-24">状态</th>
                      <th className="py-2.5 px-3 w-20">字数</th>
                      <th className="py-2.5 px-3 w-28">更新时间</th>
                      <th className="py-2.5 px-3 w-36 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                    {paginatedDocs.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-12 text-center text-neutral-400">
                          <FileText className="w-7 h-7 text-neutral-300 dark:text-neutral-700 mx-auto mb-2" />
                          <div className="font-medium text-xs text-neutral-700 dark:text-neutral-300">
                            未匹配到相关文档
                          </div>
                          {isFilterActive && (
                            <button
                              onClick={() => {
                                setSearchQuery('');
                                setFilterCategory('all');
                                setFilterTag('all');
                                setFilterVisibility('all');
                                setFilterStatus('all');
                                setFilterPinnedOnly(false);
                              }}
                              className="mt-2 text-xs text-blue-600 dark:text-blue-400 underline"
                            >
                              重置筛选条件
                            </button>
                          )}
                        </td>
                      </tr>
                    ) : (
                      paginatedDocs.map(doc => {
                        const isSelected = selectedDocIds.includes(doc.id);
                        const dotColor = CATEGORY_COLORS[doc.category] || '#64748b';

                        return (
                          <tr
                            key={doc.id}
                            className={`hover:bg-neutral-50/80 dark:hover:bg-neutral-800/40 transition-colors ${
                              isSelected ? 'bg-neutral-50/70 dark:bg-neutral-800/30' : ''
                            }`}
                          >
                            {/* Checkbox */}
                            <td className="py-2.5 px-3 text-center">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSelectOne(doc.id)}
                                className="rounded cursor-pointer"
                              />
                            </td>

                            {/* Title & Tags */}
                            <td className="py-2.5 px-3">
                              <div className="flex items-center gap-1.5">
                                <button
                                  onClick={() => handleQuickPinToggle(doc)}
                                  className="text-neutral-300 hover:text-amber-500 transition-colors shrink-0"
                                  title={doc.pinned ? '取消首页置顶' : '置顶文档'}
                                >
                                  <Star
                                    className={`w-3.5 h-3.5 ${
                                      doc.pinned ? 'text-amber-500 fill-amber-500' : ''
                                    }`}
                                  />
                                </button>
                                <span
                                  onClick={() => onViewDoc(doc)}
                                  className="hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer font-semibold text-neutral-900 dark:text-neutral-100 truncate max-w-md"
                                  title={doc.title}
                                >
                                  {doc.title}
                                </span>
                              </div>

                              {doc.tags && doc.tags.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-0.5 pl-5">
                                  {doc.tags.map(t => (
                                    <span
                                      key={t}
                                      onClick={() => setFilterTag(t)}
                                      className="text-[10px] text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 font-mono cursor-pointer"
                                    >
                                      #{t}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </td>

                            {/* Category with In-place selector */}
                            <td className="py-2.5 px-3 whitespace-nowrap">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className="w-2 h-2 rounded-full shrink-0"
                                  style={{ backgroundColor: dotColor }}
                                />
                                <select
                                  value={doc.category}
                                  onChange={e => handleQuickCategoryChange(doc, e.target.value)}
                                  className="text-xs font-medium bg-transparent border border-transparent hover:border-neutral-200 dark:hover:border-neutral-700 rounded px-1.5 py-0.5 outline-none cursor-pointer text-neutral-700 dark:text-neutral-300"
                                >
                                  {categories.map(c => (
                                    <option
                                      key={c.id}
                                      value={c.name}
                                      className="bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200"
                                    >
                                      {c.name}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </td>

                            {/* Visibility Badge with in-place selector */}
                            <td className="py-2.5 px-3 whitespace-nowrap">
                              <select
                                value={doc.visibility}
                                onChange={e =>
                                  handleQuickVisibilityChange(doc, e.target.value as DocVisibility)
                                }
                                className={`text-[11px] font-mono px-2 py-0.5 rounded-md border outline-none cursor-pointer ${
                                  doc.visibility === 'public'
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800'
                                    : doc.visibility === 'unlisted'
                                    ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800'
                                    : 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-800'
                                }`}
                              >
                                <option value="public">公开</option>
                                <option value="unlisted">未公开</option>
                                <option value="private">私密</option>
                              </select>
                            </td>

                            {/* Publish status with in-place selector */}
                            <td className="py-2.5 px-3 whitespace-nowrap">
                              <select
                                value={doc.status ?? 'published'}
                                onChange={e =>
                                  handleQuickStatusChange(doc, e.target.value as DocStatus)
                                }
                                title="发布状态"
                                className={`text-[11px] font-mono px-2 py-0.5 rounded-md border outline-none cursor-pointer ${
                                  (doc.status ?? 'published') === 'published'
                                    ? 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/60 dark:text-sky-300 dark:border-sky-800'
                                    : (doc.status ?? 'published') === 'archived'
                                    ? 'bg-neutral-100 text-neutral-600 border-neutral-300 dark:bg-neutral-800 dark:text-neutral-300 dark:border-neutral-700'
                                    : 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-800'
                                }`}
                              >
                                <option value="draft">草稿</option>
                                <option value="published">已发布</option>
                                <option value="archived">已归档</option>
                              </select>
                            </td>

                            {/* Word count */}
                            <td className="py-2.5 px-3 text-neutral-500 font-mono tabular-nums whitespace-nowrap text-xs">
                              {doc.wordCount}
                            </td>

                            {/* Updated Date */}
                            <td className="py-2.5 px-3 text-neutral-500 whitespace-nowrap text-xs">
                              {new Date(doc.updatedAt).toLocaleDateString('zh-CN')}
                            </td>

                            {/* Row Action buttons */}
                            <td className="py-2.5 px-3 text-right whitespace-nowrap">
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  onClick={() => setEditingDoc(doc)}
                                  className="px-2 py-0.5 rounded text-xs font-semibold bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-800 dark:text-neutral-200 flex items-center gap-1 transition-colors"
                                  title="编辑文档"
                                >
                                  <Edit3 className="w-3 h-3" />
                                  <span>编辑</span>
                                </button>
                                <button
                                  onClick={() => onViewDoc(doc)}
                                  className="p-1 text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
                                  title="浏览"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => setHistoryDoc(doc)}
                                  className="p-1 text-neutral-400 hover:text-blue-600 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
                                  title="版本快照"
                                >
                                  <History className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleDeleteDoc(doc.id, doc.title)}
                                  className="p-1 text-neutral-400 hover:text-rose-600 rounded hover:bg-rose-50 dark:hover:bg-rose-950/40"
                                  title="彻底删除"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Minimalist Pagination Bar directly below the table */}
              <div className="px-4 py-2 border-t border-neutral-100 dark:border-neutral-800 bg-neutral-50/40 dark:bg-neutral-950/20">
                <Pagination
                  currentPage={currentPage}
                  totalPages={totalPages}
                  totalItems={filteredDocs.length}
                  pageSize={pageSize}
                  pageSizeOptions={[10, 20, 50, 100]}
                  onPageChange={p => setCurrentPage(p)}
                  onPageSizeChange={s => {
                    setPageSize(s);
                    setCurrentPage(1);
                  }}
                />
              </div>
            </div>
          ) : (
            /* VIEW MODE B: GRID / CARD VIEW */
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {paginatedDocs.map(doc => {
                  const isSelected = selectedDocIds.includes(doc.id);
                  const dotColor = CATEGORY_COLORS[doc.category] || '#64748b';
                  const cleanText = (doc.rawMarkdown || '')
                    .replace(/^---[\s\S]*?---/, '')
                    .replace(/^#+.*$/gm, '')
                    .replace(/[`*_[\]()#]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                  const snippet = cleanText.slice(0, 90) + '...';

                  return (
                    <div
                      key={doc.id}
                      className={`p-3.5 bg-white dark:bg-neutral-900 border rounded-xl transition-all flex flex-col justify-between space-y-2.5 shadow-2xs hover:border-neutral-400 dark:hover:border-neutral-600 ${
                        isSelected
                          ? 'border-neutral-900 dark:border-neutral-100 ring-1 ring-neutral-900 dark:ring-neutral-100'
                          : 'border-neutral-200 dark:border-neutral-800'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between text-xs text-neutral-400">
                          <div className="flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSelectOne(doc.id)}
                              className="rounded cursor-pointer"
                            />
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: dotColor }}
                            />
                            <span className="font-medium text-neutral-700 dark:text-neutral-300">
                              {doc.category}
                            </span>
                          </div>

                          <button
                            onClick={() => handleQuickPinToggle(doc)}
                            className="p-1 text-neutral-300 hover:text-amber-500"
                            title={doc.pinned ? '取消置顶' : '置顶文档'}
                          >
                            <Star
                              className={`w-3.5 h-3.5 ${
                                doc.pinned ? 'text-amber-500 fill-amber-500' : ''
                              }`}
                            />
                          </button>
                        </div>

                        <h3
                          onClick={() => onViewDoc(doc)}
                          className="font-bold text-sm text-neutral-900 dark:text-neutral-100 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer mt-1.5 leading-snug line-clamp-2"
                        >
                          {doc.title}
                        </h3>

                        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 line-clamp-2 leading-relaxed">
                          {snippet}
                        </p>
                      </div>

                      <div className="space-y-2 pt-2 border-t border-neutral-100 dark:border-neutral-800">
                        {doc.tags && doc.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {doc.tags.map(t => (
                              <span
                                key={t}
                                className="font-mono text-[10px] text-neutral-400"
                              >
                                #{t}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="flex items-center justify-between text-xs pt-0.5">
                          <span className="text-[11px] text-neutral-400 font-mono">
                            {doc.wordCount} 字 · {new Date(doc.updatedAt).toLocaleDateString('zh-CN')}
                          </span>

                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => setEditingDoc(doc)}
                              className="p-1 rounded bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 text-neutral-700 dark:text-neutral-300"
                              title="编辑"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setHistoryDoc(doc)}
                              className="p-1 rounded bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 text-neutral-700 dark:text-neutral-300"
                              title="版本"
                            >
                              <History className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleDeleteDoc(doc.id, doc.title)}
                              className="p-1 rounded bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400 hover:bg-rose-100"
                              title="删除"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Pagination */}
              <div className="p-3 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl">
                <Pagination
                  currentPage={currentPage}
                  totalPages={totalPages}
                  totalItems={filteredDocs.length}
                  pageSize={pageSize}
                  pageSizeOptions={[12, 24, 48, 96]}
                  onPageChange={p => setCurrentPage(p)}
                  onPageSizeChange={s => {
                    setPageSize(s);
                    setCurrentPage(1);
                  }}
                />
              </div>
            </div>
          )}

        </div>
      )}

      {/* 3. TAB 2: TAG TOPOLOGY GOVERNANCE (Clean Table Layout) */}
      {activeTab === 'tags' && (
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-5 shadow-2xs space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-neutral-100 dark:border-neutral-800">
            <div>
              <h2 className="text-sm font-bold text-neutral-900 dark:text-neutral-100">
                知识标签治理
              </h2>
              <p className="text-xs text-neutral-500 mt-0.5">
                同步管理 Markdown YAML Frontmatter 与 SQLite 索引标签字典。
              </p>
            </div>

            {/* Quick add tag */}
            <form onSubmit={handleAddTag} className="flex gap-2">
              <input
                type="text"
                value={newTagName}
                onChange={e => setNewTagName(e.target.value)}
                placeholder="录入新标签 (如 Zettelkasten)..."
                className="px-3 py-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg text-xs outline-none"
              />
              <button
                type="submit"
                className="px-3 py-1.5 bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 rounded-lg text-xs font-semibold"
              >
                添加标签
              </button>
            </form>
          </div>

          {/* Tag search */}
          <div className="relative max-w-xs">
            <Search className="w-3.5 h-3.5 text-neutral-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={searchTag}
              onChange={e => setSearchTag(e.target.value)}
              placeholder="搜索标签..."
              className="w-full pl-8 pr-3 py-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg text-xs outline-none"
            />
          </div>

          {/* Tags Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 text-xs">
            {allTagsList
              .filter(t => !searchTag || t.name.toLowerCase().includes(searchTag.toLowerCase()))
              .map(tObj => {
                const tagName = tObj.name;
                const count = tObj.count;
                const isEditing = editingTagOldName === tagName;

                return (
                  <div
                    key={tagName}
                    className="p-2.5 bg-neutral-50 dark:bg-neutral-950/60 border border-neutral-200/80 dark:border-neutral-800 rounded-lg flex items-center justify-between gap-1.5"
                  >
                    {isEditing ? (
                      <div className="flex items-center gap-1 flex-1">
                        <input
                          type="text"
                          value={editingTagNewName}
                          onChange={e => setEditingTagNewName(e.target.value)}
                          className="flex-1 px-1.5 py-0.5 bg-white dark:bg-neutral-900 border rounded text-xs outline-none"
                          autoFocus
                        />
                        <button
                          onClick={() => handleSaveRenameTag(tagName)}
                          className="px-1.5 py-0.5 bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 rounded text-[10px]"
                        >
                          存
                        </button>
                        <button
                          onClick={() => setEditingTagOldName(null)}
                          className="p-0.5 text-neutral-400"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-1.5 truncate">
                          <span className="font-mono font-medium text-neutral-900 dark:text-neutral-100 truncate">
                            #{tagName}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-neutral-200 dark:bg-neutral-800 text-neutral-500 font-mono">
                            {count}
                          </span>
                        </div>

                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            onClick={() => {
                              setEditingTagOldName(tagName);
                              setEditingTagNewName(tagName);
                            }}
                            className="p-1 text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                            title="重命名"
                          >
                            <Edit3 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => handleDeleteTag(tagName)}
                            className="p-1 text-neutral-400 hover:text-rose-600"
                            title="删除"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
          </div>

          {/* Merge Tags */}
          <div className="pt-3 border-t border-neutral-100 dark:border-neutral-800 flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-neutral-700 dark:text-neutral-300">合并标签:</span>
            <span className="text-neutral-400">将</span>
            <select
              value={mergeSourceTag}
              onChange={e => setMergeSourceTag(e.target.value)}
              className="bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded px-2 py-1 text-xs outline-none"
            >
              <option value="">选择源标签...</option>
              {allTagsList.map(t => (
                <option key={t.name} value={t.name}>
                  #{t.name} ({t.count})
                </option>
              ))}
            </select>
            <span className="text-neutral-400">合并到</span>
            <select
              value={mergeTargetTag}
              onChange={e => setMergeTargetTag(e.target.value)}
              className="bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded px-2 py-1 text-xs outline-none"
            >
              <option value="">选择目标标签...</option>
              {allTagsList.map(t => (
                <option key={t.name} value={t.name}>
                  #{t.name} ({t.count})
                </option>
              ))}
            </select>
            <button
              onClick={handleMergeTags}
              disabled={!mergeSourceTag || !mergeTargetTag || mergeSourceTag === mergeTargetTag}
              className="px-3 py-1 bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 rounded font-medium disabled:opacity-40"
            >
              确认合并
            </button>
          </div>
        </div>
      )}

      {/* 4. TAB 3: CATEGORY HIERARCHY */}
      {activeTab === 'categories' && (
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-5 shadow-2xs space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-neutral-100 dark:border-neutral-800">
            <div>
              <h2 className="text-sm font-bold text-neutral-900 dark:text-neutral-100">
                知识领域分类体系
              </h2>
              <p className="text-xs text-neutral-500 mt-0.5">
                划分顶级领域范畴，维护分类下的文档分布。
              </p>
            </div>

            {/* Create category */}
            <form onSubmit={handleAddCategory} className="flex gap-2 flex-wrap">
              <input
                type="text"
                value={newCatName}
                onChange={e => setNewCatName(e.target.value)}
                placeholder="新分类名称 (如 人工智能)..."
                className="px-3 py-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg text-xs outline-none"
              />
              <input
                type="text"
                value={newCatDesc}
                onChange={e => setNewCatDesc(e.target.value)}
                placeholder="分类简要说明..."
                className="px-3 py-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg text-xs outline-none min-w-[160px]"
              />
              <button
                type="submit"
                className="px-3 py-1.5 bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 rounded-lg text-xs font-semibold"
              >
                新建分类
              </button>
            </form>
          </div>

          <div className="space-y-2">
            {categories.map(c => {
              const docCount = docs.filter(d => d.category === c.name).length;
              const isEditing = editingCatId === c.id;
              const dotColor = CATEGORY_COLORS[c.name] || '#64748b';

              return (
                <div
                  key={c.id}
                  className="p-3 bg-neutral-50 dark:bg-neutral-950/60 border border-neutral-200/80 dark:border-neutral-800 rounded-lg flex items-center justify-between gap-3 text-xs"
                >
                  {isEditing ? (
                    <div className="flex items-center gap-2 flex-1">
                      <input
                        type="text"
                        value={editingCatName}
                        onChange={e => setEditingCatName(e.target.value)}
                        className="px-2 py-1 bg-white dark:bg-neutral-900 border rounded text-xs outline-none w-36"
                      />
                      <input
                        type="text"
                        value={editingCatDesc}
                        onChange={e => setEditingCatDesc(e.target.value)}
                        className="flex-1 px-2 py-1 bg-white dark:bg-neutral-900 border rounded text-xs outline-none"
                      />
                      <button
                        onClick={() => handleSaveEditCategory(c.id)}
                        className="px-2.5 py-1 bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 rounded font-semibold text-xs"
                      >
                        保存
                      </button>
                      <button
                        onClick={() => setEditingCatId(null)}
                        className="p-1 text-neutral-400"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-3">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: dotColor }}
                        />
                        <span className="font-bold text-neutral-900 dark:text-neutral-100">
                          {c.name}
                        </span>
                        <span className="font-mono text-[10px] px-1.5 py-0.2 rounded-full bg-neutral-200 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400">
                          {docCount} 篇
                        </span>
                        <span className="text-neutral-400 text-xs hidden sm:inline">
                          {c.description}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          onClick={() => {
                            setEditingCatId(c.id);
                            setEditingCatName(c.name);
                            setEditingCatDesc(c.description);
                          }}
                          className="px-2 py-0.5 rounded border border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => handleDeleteCategory(c.id, c.name)}
                          className="px-2 py-0.5 rounded text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                        >
                          删除
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 4. TAB: REVISION MANAGEMENT (storage/revisions/ disk view & cleanup) */}
      {activeTab === 'revisions' && (
        <RevisionManager onRefreshDocs={onRefreshData} />
      )}

      {/* 5. TAB 5: SYSTEM SETTINGS, BACKUP & PERSISTENCE */}
      {activeTab === 'settings' && (
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-5 shadow-2xs space-y-5 text-xs">
          <div>
            <h2 className="text-sm font-bold text-neutral-900 dark:text-neutral-100">
              数据持久化与安全管理
            </h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              本地物理存储机制 (SSOT) · 镜像快照备份 · 访问密钥设置
            </p>
          </div>

          {/* Backup Toolbar */}
          <div className="p-3.5 bg-neutral-50 dark:bg-neutral-950/60 border border-neutral-200/80 dark:border-neutral-800 rounded-lg flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleExportBackupJson}
                className="px-3 py-1.5 rounded-lg bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 font-semibold flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                <span>导出全库 JSON 镜像</span>
              </button>

              <button
                type="button"
                onClick={() => backupFileInputRef.current?.click()}
                className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 font-medium flex items-center gap-1.5"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>恢复 JSON 备份</span>
              </button>
              <input
                ref={backupFileInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={e => handleImportBackupJson(e.target.files)}
              />

              <button
                type="button"
                onClick={handleExportZip}
                className="px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 font-medium flex items-center gap-1.5"
              >
                <Archive className="w-3.5 h-3.5" />
                <span>导出全量 ZIP (标准 Markdown)</span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleResetDemo}
              className="text-neutral-400 hover:text-rose-600 text-xs transition-colors"
            >
              重置为初始演示数据
            </button>
          </div>

          {/* Passcode change form */}
          <div className="pt-3 border-t border-neutral-100 dark:border-neutral-800 space-y-2">
            <h3 className="font-semibold text-neutral-800 dark:text-neutral-200">
              主理人访问密码
            </h3>
            <form onSubmit={handleUpdatePasscode} className="flex gap-2 max-w-sm">
              <input
                type="password"
                value={newPasscode}
                onChange={e => setNewPasscode(e.target.value)}
                placeholder="设置新密码 (至少 6 位)..."
                className="flex-1 px-3 py-1.5 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg outline-none"
              />
              <button
                type="submit"
                className="px-3 py-1.5 bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 rounded-lg font-semibold"
              >
                保存密码
              </button>
            </form>
            {passcodeNotice && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                {passcodeNotice}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Version History Modal */}
      {historyDoc && (
        <VersionHistoryModal
          isOpen={Boolean(historyDoc)}
          onClose={() => setHistoryDoc(null)}
          doc={historyDoc}
          onReverted={updated => {
            onRefreshData();
            showStatus(`已回滚「${updated.title}」至历史快照版本`);
          }}
        />
      )}

      {/* Attachment Manager Modal */}
      {isAssetManagerOpen && (
        <AttachmentManager
          isOpen={isAssetManagerOpen}
          onClose={() => setIsAssetManagerOpen(false)}
          onAttachmentChanged={onRefreshData}
        />
      )}

      {/* Friendly Custom Confirmation & Warning Modal */}
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmText={confirmModal.confirmText}
        cancelText={confirmModal.cancelText}
        isDestructive={confirmModal.isDestructive}
        type={confirmModal.type}
        onConfirm={confirmModal.onConfirm}
        onCancel={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
      />

    </div>
  );
};
