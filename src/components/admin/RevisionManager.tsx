import React, { useState, useEffect, useMemo } from 'react';
import {
  History,
  Trash2,
  RefreshCw,
  HardDrive,
  FileText,
  ChevronDown,
  ChevronRight,
  Search,
  Sparkles,
  Eye,
  X,
  AlertTriangle,
  Folder,
  Calendar,
  Check,
  RotateCcw,
} from 'lucide-react';
import { apiClient } from '../../services/apiClient';
import { ConfirmModal } from '../common/ConfirmModal';

interface RevisionFileItem {
  id: string;
  fileName: string;
  size: number;
  createdAt: string;
  versionNumber: number | null;
  note: string;
  relativePath: string;
}

interface RevisionDocGroup {
  documentId: string;
  title: string;
  category: string;
  slug: string;
  updatedAt: string;
  totalBytes: number;
  revisionCount: number;
  latestRevisionAt: string;
  revisions: RevisionFileItem[];
}

interface RevisionOverviewData {
  totalDocumentsWithRevisions: number;
  totalRevisionsCount: number;
  totalDiskBytes: number;
  groups: RevisionDocGroup[];
}

interface RevisionManagerProps {
  onRefreshDocs?: () => void;
}

export const RevisionManager: React.FC<RevisionManagerProps> = ({ onRefreshDocs }) => {
  const [data, setData] = useState<RevisionOverviewData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<'bytes_desc' | 'count_desc' | 'updated_desc'>('bytes_desc');
  const [expandedDocIds, setExpandedDocIds] = useState<Set<string>>(new Set());
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Snapshot preview modal state
  const [previewSnapshot, setPreviewSnapshot] = useState<{
    docTitle: string;
    versionNumber: number | null;
    note: string;
    createdAt: string;
    size: number;
    content: string | null;
    isLoading: boolean;
  } | null>(null);

  // Friendly confirmation modal state
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

  const showStatus = (msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage(null), 4000);
  };

  const loadData = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.getRevisionsOverview();
      if (res.data) {
        setData(res.data);
      }
    } catch (err: any) {
      showStatus(`读取磁盘快照概览失败: ${err?.message || '网络异常'}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const toggleExpand = (docId: string) => {
    setExpandedDocIds(prev => {
      const next = new Set(prev);
      if (next.has(docId)) {
        next.delete(docId);
      } else {
        next.add(docId);
      }
      return next;
    });
  };

  const expandAll = () => {
    if (!data) return;
    setExpandedDocIds(new Set(data.groups.map(g => g.documentId)));
  };

  const collapseAll = () => {
    setExpandedDocIds(new Set());
  };

  // 1. Global one-click prune: keep latest 1 per document
  const handleGlobalPruneKeepLatest = () => {
    setConfirmModal({
      isOpen: true,
      title: '一键空间瘦身（每篇仅保留最新 1 版）',
      message:
        '系统将扫描 storage/revisions/ 下所有文档的快照目录，仅保留各文档最新的 1 个历史版本，彻底删除其余所有过期历史快照。\n\n此操作将显著释放磁盘空间，确定执行吗？',
      confirmText: '立即执行瘦身',
      cancelText: '取消',
      isDestructive: false,
      type: 'warning',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        showStatus('正在执行全局版本瘦身清理...');
        try {
          const res = await apiClient.cleanupRevisions({ keepLatest: 1 });
          if (res.data) {
            const { cleanedCount, freedBytes, remainingCount } = res.data;
            const mb = (freedBytes / (1024 * 1024)).toFixed(2);
            showStatus(`瘦身完成：成功物理删除 ${cleanedCount} 个历史文件，释放 ${mb} MB 磁盘空间 (当前保留 ${remainingCount} 个有效最新版本)`);
            await loadData();
            onRefreshDocs?.();
          }
        } catch (err: any) {
          showStatus(`清理失败: ${err?.message || '磁盘操作异常'}`);
        }
      },
    });
  };

  // 2. Global complete purge: clear all revisions
  const handleGlobalPurgeAll = () => {
    setConfirmModal({
      isOpen: true,
      title: '清空全部历史版本快照',
      message:
        '⚠️ 警告：系统将清空 storage/revisions/ 文件夹内的所有历史快照文件，重置历史版本记录为 0。\n（当前正在编辑的正文与 storage/documents/ 文件完全不受影响）。\n\n确定彻底清空所有历史版本吗？',
      confirmText: '彻底清空全部历史',
      cancelText: '取消',
      isDestructive: true,
      type: 'danger',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        showStatus('正在清空所有历史快照...');
        try {
          const res = await apiClient.cleanupRevisions({ all: true });
          if (res.data) {
            const { cleanedCount, freedBytes } = res.data;
            const mb = (freedBytes / (1024 * 1024)).toFixed(2);
            showStatus(`清空完成：移除了全部 ${cleanedCount} 个历史快照文件，共释放 ${mb} MB 磁盘空间`);
            await loadData();
            onRefreshDocs?.();
          }
        } catch (err: any) {
          showStatus(`清空失败: ${err?.message || '磁盘操作异常'}`);
        }
      },
    });
  };

  // 3. Single document: prune older, keep latest 1
  const handlePruneDocKeepLatest = (docGroup: RevisionDocGroup) => {
    setConfirmModal({
      isOpen: true,
      title: `瘦身文档「${docGroup.title}」历史版本`,
      message: `确定清理文档「${docGroup.title}」的过期版本吗？\n将仅保留其最新的 1 个历史版本，物理删除其余 ${docGroup.revisionCount - 1} 个快照文件。`,
      confirmText: '保留最新版并清理',
      cancelText: '取消',
      isDestructive: false,
      type: 'warning',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        try {
          const res = await apiClient.cleanupRevisions({
            documentId: docGroup.documentId,
            keepLatest: 1,
          });
          if (res.data) {
            const { cleanedCount, freedBytes } = res.data;
            const kb = (freedBytes / 1024).toFixed(1);
            showStatus(`已为「${docGroup.title}」清理 ${cleanedCount} 个历史快照，释放 ${kb} KB 空间`);
            await loadData();
            onRefreshDocs?.();
          }
        } catch (err: any) {
          showStatus(`清理失败: ${err?.message || '磁盘异常'}`);
        }
      },
    });
  };

  // 4. Single document: delete all revisions
  const handleDeleteDocAllRevisions = (docGroup: RevisionDocGroup) => {
    setConfirmModal({
      isOpen: true,
      title: `清空「${docGroup.title}」全部快照`,
      message: `确定要彻底删除文档「${docGroup.title}」名下的全部 ${docGroup.revisionCount} 个历史快照文件吗？\n将删除 storage/revisions/${docGroup.documentId} 整个物理磁盘目录。`,
      confirmText: '彻底清空此文档快照',
      cancelText: '取消',
      isDestructive: true,
      type: 'danger',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        try {
          const res = await apiClient.deleteDocumentRevisions(docGroup.documentId);
          if (res.data) {
            const { cleanedCount, freedBytes } = res.data;
            const kb = (freedBytes / 1024).toFixed(1);
            showStatus(`已清空「${docGroup.title}」的 ${cleanedCount} 个历史快照，释放 ${kb} KB 空间`);
            await loadData();
            onRefreshDocs?.();
          }
        } catch (err: any) {
          showStatus(`删除失败: ${err?.message || '磁盘异常'}`);
        }
      },
    });
  };

  // 5. Delete single specific snapshot file
  const handleDeleteSingleRevision = (docGroup: RevisionDocGroup, rev: RevisionFileItem) => {
    setConfirmModal({
      isOpen: true,
      title: '删除单个版本快照',
      message: `确定要删除文档「${docGroup.title}」的历史快照文件「${rev.fileName}」吗？\n文件大小: ${(rev.size / 1024).toFixed(1)} KB\n快照备注: ${rev.note}`,
      confirmText: '删除此快照',
      cancelText: '取消',
      isDestructive: true,
      type: 'danger',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        try {
          await apiClient.deleteSingleRevision(docGroup.documentId, rev.id);
          showStatus(`已删除快照 ${rev.fileName}`);
          await loadData();
          onRefreshDocs?.();
        } catch (err: any) {
          showStatus(`删除失败: ${err?.message || '磁盘异常'}`);
        }
      },
    });
  };

  // 6. View snapshot content in preview modal
  const handleOpenSnapshotPreview = async (docGroup: RevisionDocGroup, rev: RevisionFileItem) => {
    setPreviewSnapshot({
      docTitle: docGroup.title,
      versionNumber: rev.versionNumber,
      note: rev.note,
      createdAt: rev.createdAt,
      size: rev.size,
      content: null,
      isLoading: true,
    });

    try {
      const res = await apiClient.getRevisionSnapshot(docGroup.documentId, rev.id);
      if (res.data) {
        setPreviewSnapshot(prev => (prev ? { ...prev, content: res.data.rawMarkdown || '', isLoading: false } : null));
      } else {
        setPreviewSnapshot(prev => (prev ? { ...prev, content: '暂无快照内容', isLoading: false } : null));
      }
    } catch {
      setPreviewSnapshot(prev => (prev ? { ...prev, content: '读取快照内容失败', isLoading: false } : null));
    }
  };

  // Filtered and sorted groups
  const filteredGroups = useMemo(() => {
    if (!data) return [];
    let list = data.groups.filter(g => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        g.title.toLowerCase().includes(q) ||
        g.documentId.toLowerCase().includes(q) ||
        g.category.toLowerCase().includes(q) ||
        g.revisions.some(r => r.note.toLowerCase().includes(q) || r.fileName.toLowerCase().includes(q))
      );
    });

    if (sortOrder === 'bytes_desc') {
      list.sort((a, b) => b.totalBytes - a.totalBytes);
    } else if (sortOrder === 'count_desc') {
      list.sort((a, b) => b.revisionCount - a.revisionCount);
    } else if (sortOrder === 'updated_desc') {
      list.sort((a, b) => new Date(b.latestRevisionAt).getTime() - new Date(a.latestRevisionAt).getTime());
    }

    return list;
  }, [data, searchQuery, sortOrder]);

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="space-y-4">
      {/* 1. Header Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 shadow-2xs flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-950/60 border border-purple-200 dark:border-purple-800 flex items-center justify-center text-purple-600 dark:text-purple-400 shrink-0">
            <History className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs text-neutral-500 font-medium">快照总文件数</p>
            <p className="text-xl font-bold font-mono text-neutral-900 dark:text-neutral-100">
              {data ? data.totalRevisionsCount : '—'} <span className="text-xs font-normal text-neutral-400">个</span>
            </p>
          </div>
        </div>

        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 shadow-2xs flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800 flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0">
            <HardDrive className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs text-neutral-500 font-medium">磁盘占用总量</p>
            <p className="text-xl font-bold font-mono text-neutral-900 dark:text-neutral-100">
              {data ? formatBytes(data.totalDiskBytes) : '—'}
            </p>
          </div>
        </div>

        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 shadow-2xs flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <p className="text-xs text-neutral-500 font-medium">包含历史的文档</p>
            <p className="text-xl font-bold font-mono text-neutral-900 dark:text-neutral-100">
              {data ? data.totalDocumentsWithRevisions : '—'} <span className="text-xs font-normal text-neutral-400">篇</span>
            </p>
          </div>
        </div>
      </div>

      {/* Status Feedback Toast */}
      {statusMessage && (
        <div className="p-3 bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 rounded-xl text-xs flex items-center gap-2 animate-fade-in shadow-md">
          <Check className="w-4 h-4 text-emerald-400 dark:text-emerald-600 shrink-0" />
          <span className="font-medium">{statusMessage}</span>
        </div>
      )}

      {/* 2. Operations & Toolbar */}
      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl p-3 flex flex-col md:flex-row md:items-center justify-between gap-3 shadow-2xs">
        
        {/* Left: Search & Filter */}
        <div className="flex items-center gap-2 flex-wrap flex-1">
          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-neutral-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="检索文档标题、ID 或快照备注..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg outline-none focus:ring-1 focus:ring-neutral-400"
            />
          </div>

          <div className="flex items-center gap-1.5 text-xs text-neutral-500">
            <span>排序:</span>
            <select
              value={sortOrder}
              onChange={e => setSortOrder(e.target.value as any)}
              className="bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg px-2 py-1 text-xs outline-none cursor-pointer"
            >
              <option value="bytes_desc">磁盘占用 (降序)</option>
              <option value="count_desc">快照数量 (降序)</option>
              <option value="updated_desc">最新快照时间</option>
            </select>
          </div>

          <div className="flex items-center gap-1 text-xs">
            <button
              onClick={expandAll}
              className="px-2 py-1 text-[11px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded transition-colors"
            >
              全部展开
            </button>
            <span className="text-neutral-300 dark:text-neutral-700">|</span>
            <button
              onClick={collapseAll}
              className="px-2 py-1 text-[11px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded transition-colors"
            >
              全部折叠
            </button>
          </div>
        </div>

        {/* Right: Prune & Cleanup Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={loadData}
            disabled={isLoading}
            className="p-1.5 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-lg transition-colors border border-neutral-200 dark:border-neutral-800"
            title="重新扫描 storage/revisions/ 物理磁盘"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>

          <button
            onClick={handleGlobalPruneKeepLatest}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-purple-50 text-purple-700 hover:bg-purple-100 dark:bg-purple-950/60 dark:text-purple-300 dark:hover:bg-purple-900/60 border border-purple-200 dark:border-purple-800/80 transition-colors flex items-center gap-1.5 cursor-pointer shadow-2xs"
            title="保留每篇文档最新 1 版快照，删除其余旧版本"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>一键瘦身 (仅留最新 1 版)</span>
          </button>

          <button
            onClick={handleGlobalPurgeAll}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 dark:bg-rose-950/60 dark:text-rose-300 dark:hover:bg-rose-900/60 border border-rose-200 dark:border-rose-800/80 transition-colors flex items-center gap-1.5 cursor-pointer shadow-2xs"
            title="清空 storage/revisions/ 下所有快照"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>清空全部快照</span>
          </button>
        </div>

      </div>

      {/* 3. Revisions Folders & Snapshot List */}
      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden shadow-2xs">
        
        {/* Table/List Header */}
        <div className="px-4 py-2.5 bg-neutral-50/80 dark:bg-neutral-950/80 border-b border-neutral-200 dark:border-neutral-800 text-xs font-medium text-neutral-500 flex items-center justify-between font-mono">
          <div className="flex items-center gap-2">
            <Folder className="w-3.5 h-3.5 text-neutral-400" />
            <span>物理磁盘目录: storage/revisions/</span>
          </div>
          <div>共 {filteredGroups.length} 个文档快照目录</div>
        </div>

        {/* Content Rows */}
        {filteredGroups.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center text-neutral-400 mx-auto">
              <History className="w-6 h-6" />
            </div>
            <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
              {data && data.groups.length === 0 ? 'storage/revisions/ 文件夹目前没有任何历史快照' : '未检索到匹配的快照目录'}
            </p>
            <p className="text-xs text-neutral-400 max-w-sm mx-auto leading-relaxed">
              当您在编辑器中保存文档修改时，系统会自动在 storage/revisions/{'{docId}'} 生成快照以供历史回滚。
            </p>
          </div>
        ) : (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {filteredGroups.map(group => {
              const isExpanded = expandedDocIds.has(group.documentId);
              return (
                <div key={group.documentId} className="transition-colors hover:bg-neutral-50/50 dark:hover:bg-neutral-800/20">
                  
                  {/* Document Group Header Row */}
                  <div
                    className="p-3.5 sm:px-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 cursor-pointer select-none"
                    onClick={() => toggleExpand(group.documentId)}
                  >
                    <div className="flex items-start sm:items-center gap-2.5 min-w-0">
                      <button
                        type="button"
                        className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 rounded mt-0.5 sm:mt-0"
                      >
                        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      </button>

                      <div className="space-y-0.5 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-bold text-neutral-900 dark:text-neutral-100 truncate">
                            {group.title}
                          </span>
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 border border-neutral-200/60 dark:border-neutral-700/60">
                            {group.category}
                          </span>
                        </div>
                        <p className="text-[11px] text-neutral-400 font-mono truncate">
                          storage/revisions/{group.documentId}/
                        </p>
                      </div>
                    </div>

                    {/* Stats & Actions */}
                    <div className="flex items-center gap-3 shrink-0 self-end sm:self-auto" onClick={e => e.stopPropagation()}>
                      <div className="text-right text-xs">
                        <div className="flex items-center gap-2 font-mono">
                          <span className="px-2 py-0.5 rounded-md bg-purple-50 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 font-semibold text-[11px] border border-purple-200/60 dark:border-purple-800/60">
                            {group.revisionCount} 个快照
                          </span>
                          <span className="px-2 py-0.5 rounded-md bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 font-semibold text-[11px]">
                            {formatBytes(group.totalBytes)}
                          </span>
                        </div>
                        <p className="text-[10px] text-neutral-400 mt-0.5">
                          最新: {new Date(group.latestRevisionAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>

                      {/* Action buttons for single doc */}
                      <div className="flex items-center gap-1 border-l border-neutral-200 dark:border-neutral-800 pl-3">
                        {group.revisionCount > 1 && (
                          <button
                            type="button"
                            onClick={() => handlePruneDocKeepLatest(group)}
                            className="px-2.5 py-1 text-[11px] rounded-md font-medium text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-950/60 transition-colors"
                            title="仅保留最新 1 版快照，清理历史旧版本"
                          >
                            留最新 1 版
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDeleteDocAllRevisions(group)}
                          className="p-1.5 text-neutral-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/60 rounded-md transition-colors"
                          title="彻底删除此文档的名下所有快照"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Expanded Individual Revision Snapshot Files */}
                  {isExpanded && (
                    <div className="px-4 pb-3 pt-1 bg-neutral-50/60 dark:bg-neutral-950/40 border-t border-neutral-100 dark:border-neutral-800/80">
                      <div className="space-y-1.5 pt-1">
                        {group.revisions.map((rev, index) => {
                          const isNewest = index === 0;
                          return (
                            <div
                              key={rev.id}
                              className="flex items-center justify-between p-2 rounded-lg bg-white dark:bg-neutral-900 border border-neutral-200/70 dark:border-neutral-800/70 text-xs shadow-2xs"
                            >
                              <div className="flex items-center gap-2.5 min-w-0">
                                <span className={`font-mono text-[11px] font-bold px-2 py-0.5 rounded ${
                                  isNewest
                                    ? 'bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300'
                                    : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400'
                                }`}>
                                  {rev.versionNumber ? `v${rev.versionNumber}` : `#${group.revisions.length - index}`}
                                </span>

                                <div className="min-w-0 space-y-0.5">
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium text-neutral-800 dark:text-neutral-200 truncate">
                                      {rev.note}
                                    </span>
                                    {isNewest && (
                                      <span className="text-[10px] bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.2 rounded font-medium">
                                        最新有效版
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-[10px] text-neutral-400 font-mono">
                                    {rev.fileName} · {formatBytes(rev.size)} · {new Date(rev.createdAt).toLocaleString('zh-CN')}
                                  </p>
                                </div>
                              </div>

                              <div className="flex items-center gap-1 shrink-0 ml-2">
                                <button
                                  type="button"
                                  onClick={() => handleOpenSnapshotPreview(group, rev)}
                                  className="px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 text-[11px] flex items-center gap-1 transition-colors"
                                  title="查看快照 Markdown 文本"
                                >
                                  <Eye className="w-3 h-3" />
                                  <span>查看内容</span>
                                </button>

                                <button
                                  type="button"
                                  onClick={() => handleDeleteSingleRevision(group, rev)}
                                  className="p-1 text-neutral-400 hover:text-rose-600 dark:hover:text-rose-400 rounded transition-colors"
                                  title="删除此单个快照文件"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Snapshot Content Preview Modal */}
      {previewSnapshot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs">
          <div
            className="w-full max-w-3xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden animate-scale-up"
            onClick={e => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
              <div className="space-y-0.5">
                <h3 className="text-base font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
                  <span>历史快照详情</span>
                  {previewSnapshot.versionNumber && (
                    <span className="font-mono text-xs px-2 py-0.5 rounded bg-purple-100 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 font-bold">
                      v{previewSnapshot.versionNumber}
                    </span>
                  )}
                </h3>
                <p className="text-xs text-neutral-500">
                  {previewSnapshot.docTitle} · {previewSnapshot.note} · {formatBytes(previewSnapshot.size)} · {new Date(previewSnapshot.createdAt).toLocaleString('zh-CN')}
                </p>
              </div>

              <button
                onClick={() => setPreviewSnapshot(null)}
                className="p-1.5 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="flex-1 p-6 overflow-y-auto font-mono text-xs text-neutral-800 dark:text-neutral-200 bg-neutral-50 dark:bg-neutral-950 leading-relaxed whitespace-pre-wrap select-text">
              {previewSnapshot.isLoading ? (
                <div className="flex items-center justify-center py-16 text-neutral-400">
                  <RefreshCw className="w-5 h-5 animate-spin mr-2" />
                  <span>正在从磁盘读取快照文件...</span>
                </div>
              ) : (
                previewSnapshot.content || '快照内容为空'
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3 border-t border-neutral-200 dark:border-neutral-800 flex justify-between items-center text-xs text-neutral-500 bg-white dark:bg-neutral-900 shrink-0">
              <span>文件来源：storage/revisions/ 物理磁盘快照</span>
              <button
                onClick={() => setPreviewSnapshot(null)}
                className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 hover:opacity-90"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reusable Confirm Modal */}
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
