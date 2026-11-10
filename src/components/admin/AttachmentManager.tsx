import React, { useState, useEffect, useRef } from 'react';
import {
  Paperclip,
  Upload,
  X,
  Trash2,
  Copy,
  Check,
  Download,
  Image as ImageIcon,
  File,
  HardDrive,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { Attachment } from '../../types';
import { storage } from '../../services/storage';
import { apiClient } from '../../services/apiClient';
import { ConfirmModal } from '../common/ConfirmModal';

interface PhysicalAsset {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
  createdAt: string;
}

interface AttachmentManagerProps {
  isOpen: boolean;
  onClose: () => void;
  docId?: string;
  onInsertMarkdown?: (markdownSnippet: string) => void;
  onAttachmentChanged?: () => void;
}

export const AttachmentManager: React.FC<AttachmentManagerProps> = ({
  isOpen,
  onClose,
  docId,
  onInsertMarkdown,
  onAttachmentChanged,
}) => {
  const [activeTab, setActiveTab] = useState<'upload' | 'library'>('library');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [physicalAssets, setPhysicalAssets] = useState<PhysicalAsset[]>([]);
  const [isLoadingAssets, setIsLoadingAssets] = useState(false);
  const [isCleaningOrphans, setIsCleaningOrphans] = useState(false);
  const [cleanFeedback, setCleanFeedback] = useState<string | null>(null);
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load assets from backend physical storage on open
  const loadAssets = async () => {
    setIsLoadingAssets(true);
    try {
      const res = await apiClient.getAssets();
      if (res.data && Array.isArray(res.data)) {
        setPhysicalAssets(res.data);
      }
    } catch {
      // Fallback
    } finally {
      setIsLoadingAssets(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadAssets();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // Local storage attachments for backward compatibility (entire library)
  const localAttachments = storage.getAttachments();

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);
    setUploadError(null);
    setUploadSuccess(null);

    const file = files[0];

    const reader = new FileReader();
    reader.onload = async e => {
      const base64Data = e.target?.result as string;

      try {
        // 1. Physically upload to Node/Express backend (saved in storage/assets/{id}.{ext})
        const uploadRes = await apiClient.uploadAsset(file.name, file.type, base64Data);

        if (uploadRes.error) {
          throw new Error(uploadRes.error.message || '上传失败');
        }

        const newAsset = uploadRes.data;
        if (newAsset) {
          setPhysicalAssets(prev => [newAsset, ...prev]);

          // Also save reference in local storage for zero-latency offline cache
          const newAtt: Attachment = {
            id: newAsset.id,
            docId,
            name: newAsset.filename,
            size: newAsset.size,
            mimeType: newAsset.mimeType,
            dataUrl: newAsset.url,
            createdAt: newAsset.createdAt,
          };
          storage.saveAttachment(newAtt);

          setUploadSuccess(`已成功持久化至 storage/assets/${newAsset.id}`);
          setActiveTab('library');
          onAttachmentChanged?.();

          // Auto-insert snippet if callback provided
          const isImage = file.type.startsWith('image/');
          const snippet = isImage
            ? `![${newAsset.filename}](${newAsset.url})\n`
            : `[📎 ${newAsset.filename}](${newAsset.url})\n`;
          onInsertMarkdown?.(snippet);
        }
      } catch (err: any) {
        setUploadError(err?.message || '附件物理持久化失败，请重试');
      } finally {
        setIsUploading(false);
      }
    };

    reader.onerror = () => {
      setIsUploading(false);
      setUploadError('读取文件失败');
    };

    reader.readAsDataURL(file);
  };

  const handleDelete = (id: string, filename?: string) => {
    setConfirmModal({
      isOpen: true,
      title: '删除物理附件',
      message: `确定要彻底删除附件「${filename || id}」吗？\n将从服务器 storage/assets/ 与数据库中永久移除文件。`,
      confirmText: '彻底删除',
      cancelText: '取消',
      isDestructive: true,
      type: 'danger',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        try {
          await apiClient.deleteAsset(id);
          setPhysicalAssets(prev => prev.filter(a => a.id !== id));
          storage.deleteAttachment(id);
          onAttachmentChanged?.();
        } catch (err: any) {
          setUploadError(`删除失败: ${err?.message || '磁盘异常'}`);
        }
      },
    });
  };

  const handleCleanupOrphans = () => {
    setConfirmModal({
      isOpen: true,
      title: '深度清理未引用孤立附件',
      message: '系统将扫描服务器 storage/documents/ 下所有 Markdown 文件，检测 storage/assets/ 中未被任何文档正文引用的物理附件并永久从磁盘清理。\n\n确定执行全面清理吗？',
      confirmText: '立即扫描并清理',
      cancelText: '取消',
      isDestructive: false,
      type: 'warning',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        setIsCleaningOrphans(true);
        setCleanFeedback('正在检索 Markdown 引用并清理孤立物理文件...');
        try {
          const res = await apiClient.cleanupOrphanAssets();
          if (res.data) {
            const { cleanedCount, freedBytes } = res.data;
            const mb = (freedBytes / (1024 * 1024)).toFixed(2);
            setCleanFeedback(`已清理 ${cleanedCount} 个未引用孤立文件，释放 ${mb} MB 磁盘空间`);
            await loadAssets();
            onAttachmentChanged?.();
          } else {
            setCleanFeedback(res.error?.message || '扫描完毕，暂无未引用附件');
          }
        } catch (err: any) {
          setCleanFeedback(`清理出错: ${err?.message || '网络或磁盘异常'}`);
        } finally {
          setIsCleaningOrphans(false);
          setTimeout(() => setCleanFeedback(null), 6000);
        }
      },
    });
  };

  const handleInsertSnippet = (asset: { id: string; filename: string; mimeType: string; url: string }) => {
    const isImage = asset.mimeType.startsWith('image/');
    const snippet = isImage
      ? `![${asset.filename}](${asset.url})`
      : `[📎 ${asset.filename}](${asset.url})`;

    if (onInsertMarkdown) {
      onInsertMarkdown(snippet);
    }
    navigator.clipboard.writeText(snippet);
    setCopiedId(asset.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Merge physical assets and any legacy local-only attachments
  const allAssetItems = React.useMemo(() => {
    const map = new Map<string, PhysicalAsset>();

    // Add local storage attachments
    localAttachments.forEach(a => {
      map.set(a.id, {
        id: a.id,
        filename: a.name,
        mimeType: a.mimeType,
        size: a.size,
        url: a.dataUrl,
        createdAt: a.createdAt,
      });
    });

    // Add authoritative physical assets from backend disk
    physicalAssets.forEach(p => {
      map.set(p.id, p);
    });

    return Array.from(map.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [physicalAssets, localAttachments]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-900/50 backdrop-blur-xs">
      <div
        className="w-full max-w-3xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800 flex items-center justify-center text-blue-600 dark:text-blue-400">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
                <span>图片与物理附件资源库</span>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 font-normal">
                  storage/assets/ 物理落盘
                </span>
              </h3>
              <p className="text-xs text-neutral-500">
                支持拖拽、截图粘贴、原图持久化存储，无需担心浏览器缓存清理
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleCleanupOrphans}
              disabled={isCleaningOrphans}
              className="px-2.5 py-1.5 text-xs font-medium text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/60 rounded-lg transition-colors border border-amber-200 dark:border-amber-800/80 flex items-center gap-1.5 disabled:opacity-50"
              title="扫描全库 Markdown 正文，清理未被引用的孤立物理附件"
            >
              <Trash2 className={`w-3.5 h-3.5 ${isCleaningOrphans ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">清理未引用附件</span>
            </button>

            <button
              onClick={loadAssets}
              disabled={isLoadingAssets}
              className="p-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              title="刷新资产列表"
            >
              <RefreshCw className={`w-4 h-4 ${isLoadingAssets ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Clean Feedback Toast Banner */}
        {cleanFeedback && (
          <div className="px-6 py-2.5 bg-amber-50 dark:bg-amber-950/60 border-b border-amber-200/80 dark:border-amber-800/80 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2 animate-fade-in shrink-0">
            <Check className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <span>{cleanFeedback}</span>
          </div>
        )}

        {/* Tab switcher */}
        <div className="flex items-center px-6 pt-3 border-b border-neutral-100 dark:border-neutral-800 text-xs font-medium gap-4 shrink-0">
          <button
            onClick={() => setActiveTab('library')}
            className={`pb-2.5 border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === 'library'
                ? 'border-neutral-900 dark:border-white text-neutral-900 dark:text-white font-semibold'
                : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-300'
            }`}
          >
            <ImageIcon className="w-3.5 h-3.5" />
            <span>媒体资源库 ({allAssetItems.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('upload')}
            className={`pb-2.5 border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === 'upload'
                ? 'border-neutral-900 dark:border-white text-neutral-900 dark:text-white font-semibold'
                : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-300'
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            <span>上传新文件 / 图片</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Upload Tab */}
          {activeTab === 'upload' && (
            <div className="space-y-4">
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-neutral-300 dark:border-neutral-700 hover:border-neutral-500 dark:hover:border-neutral-500 rounded-2xl p-8 text-center cursor-pointer transition-colors bg-neutral-50/50 dark:bg-neutral-950/40"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={e => handleFileUpload(e.target.files)}
                />
                <div className="w-12 h-12 rounded-full bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center mx-auto mb-3 text-neutral-500">
                  <Upload className="w-6 h-6" />
                </div>
                <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
                  {isUploading ? '正在物理保存中...' : '点击或拖拽文件至此处上传'}
                </p>
                <p className="text-xs text-neutral-400 mt-1">
                  支持 JPG、PNG、SVG、WebP、PDF、ZIP、Markdown 等格式
                </p>
                <p className="text-[11px] text-neutral-400 mt-2 font-mono">
                  文件将直接写入本地物理磁盘 storage/assets/
                </p>
              </div>

              {uploadError && (
                <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 text-xs text-rose-600 dark:text-rose-400">
                  {uploadError}
                </div>
              )}

              {uploadSuccess && (
                <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-900 text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
                  <Check className="w-4 h-4" />
                  <span>{uploadSuccess}</span>
                </div>
              )}
            </div>
          )}

          {/* Library Tab */}
          {activeTab === 'library' && (
            <div>
              {isLoadingAssets ? (
                <div className="text-center py-12 text-xs text-neutral-400">
                  正在读取磁盘物理附件...
                </div>
              ) : allAssetItems.length === 0 ? (
                <div className="text-center py-12 space-y-3">
                  <ImageIcon className="w-10 h-10 text-neutral-300 dark:text-neutral-700 mx-auto" />
                  <p className="text-xs text-neutral-400">
                    当前资源库暂无附件，可切换到“上传新文件”或直接在编辑器粘贴/拖拽图片
                  </p>
                  <button
                    onClick={() => setActiveTab('upload')}
                    className="px-3 py-1.5 text-xs font-medium rounded-lg bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                  >
                    立即上传第一张图片
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {allAssetItems.map(asset => {
                    const isImage = asset.mimeType.startsWith('image/');
                    return (
                      <div
                        key={asset.id}
                        className="p-3 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 text-xs flex flex-col justify-between gap-2.5 hover:border-neutral-300 dark:hover:border-neutral-700 transition-colors"
                      >
                        <div className="flex items-start gap-3">
                          {isImage ? (
                            <div className="w-14 h-14 rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden bg-neutral-100 dark:bg-neutral-800 shrink-0">
                              <img
                                src={asset.url}
                                alt={asset.filename}
                                className="w-full h-full object-cover"
                                loading="lazy"
                              />
                            </div>
                          ) : (
                            <div className="w-14 h-14 rounded-lg bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center shrink-0 text-neutral-500">
                              <File className="w-6 h-6" />
                            </div>
                          )}

                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-neutral-900 dark:text-neutral-100 truncate" title={asset.filename}>
                              {asset.filename}
                            </p>
                            <p className="text-[11px] text-neutral-400 mt-0.5">
                              {(asset.size / 1024).toFixed(1)} KB · {new Date(asset.createdAt).toLocaleDateString('zh-CN')}
                            </p>
                            <p className="text-[10px] text-neutral-400 font-mono truncate mt-0.5" title={asset.url}>
                              {asset.url}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-2 border-t border-neutral-200/60 dark:border-neutral-800/60">
                          <button
                            onClick={() => handleInsertSnippet(asset)}
                            className="px-2.5 py-1 rounded-md bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-800 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-[11px] font-medium flex items-center gap-1 transition-colors"
                          >
                            {copiedId === asset.id ? (
                              <>
                                <Check className="w-3 h-3 text-emerald-600" />
                                <span>已插入光标</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                <span>插入正文 (Markdown)</span>
                              </>
                            )}
                          </button>

                          <div className="flex items-center gap-1">
                            <a
                              href={asset.url}
                              target="_blank"
                              rel="noreferrer"
                              className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 rounded"
                              title="在浏览器中查看原图"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                            <button
                              onClick={() => handleDelete(asset.id, asset.filename)}
                              className="p-1 text-neutral-400 hover:text-rose-600 rounded transition-colors"
                              title="删除物理文件"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 flex justify-between items-center text-xs text-neutral-500 shrink-0">
          <span>存储真源：本地物理磁盘 storage/assets/</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-semibold text-neutral-900 dark:text-white bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg transition-colors"
          >
            关闭
          </button>
        </div>
      </div>

      {/* Friendly Confirm Modal */}
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
