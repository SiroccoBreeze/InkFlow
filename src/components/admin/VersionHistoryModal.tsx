import React, { useState, useEffect } from 'react';
import { History, X, RotateCcw, Check, Plus, HardDrive, RefreshCw } from 'lucide-react';
import { DocVersion, KnowledgeDoc } from '../../types';
import { storage } from '../../services/storage';
import { apiClient } from '../../services/apiClient';
import { ConfirmModal } from '../common/ConfirmModal';

interface VersionHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  doc: KnowledgeDoc;
  onReverted: (updatedDoc: KnowledgeDoc) => void;
}

export const VersionHistoryModal: React.FC<VersionHistoryModalProps> = ({
  isOpen,
  onClose,
  doc,
  onReverted,
}) => {
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [newSnapshotNote, setNewSnapshotNote] = useState('');
  const [creatingSnapshot, setCreatingSnapshot] = useState(false);
  const [revertedSuccess, setRevertedSuccess] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
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
  const [revisions, setRevisions] = useState<any[]>([]);
  const [activeSnapshotContent, setActiveSnapshotContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Load backend revisions from storage/revisions/
  const loadRevisions = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.getRevisions(doc.id);
      if (res.data && Array.isArray(res.data) && res.data.length > 0) {
        setRevisions(res.data);
        if (!selectedVersionId && res.data[0]) {
          setSelectedVersionId(res.data[0].id);
        }
      } else {
        // Fallback to local storage versions
        const localVers = storage.getVersions(doc.id);
        setRevisions(
          localVers.map(v => ({
            id: v.id,
            versionNumber: v.versionNumber,
            note: v.note,
            createdAt: v.timestamp,
            rawMarkdown: v.rawMarkdown,
          }))
        );
        if (localVers[0]) {
          setSelectedVersionId(localVers[0].id);
        }
      }
    } catch {
      const localVers = storage.getVersions(doc.id);
      setRevisions(
        localVers.map(v => ({
          id: v.id,
          versionNumber: v.versionNumber,
          note: v.note,
          createdAt: v.timestamp,
          rawMarkdown: v.rawMarkdown,
        }))
      );
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadRevisions();
    }
  }, [isOpen, doc.id]);

  // Load snapshot full markdown when selectedVersionId changes
  useEffect(() => {
    if (!selectedVersionId) return;
    const current = revisions.find(r => r.id === selectedVersionId);
    if (current?.rawMarkdown) {
      setActiveSnapshotContent(current.rawMarkdown);
      return;
    }

    // Fetch from backend
    apiClient
      .getRevisionSnapshot(doc.id, selectedVersionId)
      .then(res => {
        if (res.data?.rawMarkdown) {
          setActiveSnapshotContent(res.data.rawMarkdown);
        }
      })
      .catch(() => {});
  }, [selectedVersionId, revisions, doc.id]);

  if (!isOpen) return null;

  const currentVersion = revisions.find(v => v.id === selectedVersionId) || revisions[0];

  const handleCreateSnapshot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSnapshotNote.trim()) return;

    // Save through the same server-confirmed path as the editor. A failed save
    // must not create a fake local snapshot.
    try {
      const result = await storage.saveDoc(
        {
          id: doc.id,
          title: doc.title,
          slug: doc.slug,
          rawMarkdown: doc.rawMarkdown,
          category: doc.category,
          tags: doc.tags,
          visibility: doc.visibility,
          status: doc.status,
          pinned: doc.pinned,
          author: doc.author,
        },
        newSnapshotNote.trim()
      );

      if (!result.success) {
        setErrorMessage(`创建快照失败：${result.error?.message || '未知错误'}`);
        return;
      }

      setNewSnapshotNote('');
      setCreatingSnapshot(false);
      await loadRevisions();
    } catch (err: any) {
      setErrorMessage(`创建快照失败：${err?.message || '未知错误'}`);
    }
  };

  const handleRevert = (version: any) => {
    setConfirmModal({
      isOpen: true,
      title: '版本快照回滚',
      message: `确定要将文档回滚到版本 v${version.versionNumber} 吗？\n当前磁盘文件 storage/documents/${doc.id}/index.md 将被历史快照内容替换，并自动生成安全回滚快照。`,
      confirmText: `回滚至 v${version.versionNumber}`,
      cancelText: '取消',
      type: 'warning',
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        setReverting(true);
        setErrorMessage(null);
        try {
          const res = await apiClient.rollbackRevision(doc.id, version.id);
          if (res.data) {
            const updatedDoc: KnowledgeDoc = {
              ...doc,
              ...res.data,
              rawMarkdown: res.data.rawMarkdown || activeSnapshotContent || doc.rawMarkdown,
            };
            // The server already committed the rollback; adopt its document instead
            // of sending a second save that would create a redundant revision.
            storage.adoptServerDoc(updatedDoc);
            setRevertedSuccess(true);
            onReverted(updatedDoc);
            setTimeout(() => {
              setRevertedSuccess(false);
              onClose();
            }, 1200);
          } else {
            // Local-only fallback: still persists through the server-confirmed path.
            const result = await storage.revertToVersion(doc.id, version.id);
            if (result?.success) {
              setRevertedSuccess(true);
              onReverted(result.doc);
              setTimeout(() => {
                setRevertedSuccess(false);
                onClose();
              }, 1200);
            } else {
              setErrorMessage(`回滚失败：${result?.error?.message || '本地版本不存在'}`);
            }
          }
        } catch (err: any) {
          setErrorMessage(`回滚失败: ${err?.message || '未知错误'}`);
        } finally {
          setReverting(false);
        }
      },
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-900/50 backdrop-blur-xs">
      <div
        className="w-full max-w-4xl max-h-[85vh] bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-purple-50 dark:bg-purple-950/60 border border-purple-200 dark:border-purple-800 flex items-center justify-center text-purple-600 dark:text-purple-400">
              <History className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
                <span>版本快照与历史回溯</span>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 font-normal">
                  storage/revisions/ 物理快照
                </span>
              </h3>
              <p className="text-xs text-neutral-500 truncate max-w-md">
                文档：{doc.title}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setCreatingSnapshot(!creatingSnapshot)}
              className="px-3 py-1.5 text-xs font-medium text-neutral-800 dark:text-neutral-200 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 rounded-lg transition-colors flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>新建手动快照</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Snapshot creation banner */}
        {creatingSnapshot && (
          <form
            onSubmit={handleCreateSnapshot}
            className="p-4 bg-neutral-50 dark:bg-neutral-950/60 border-b border-neutral-200 dark:border-neutral-800 flex items-center gap-3 text-xs shrink-0"
          >
            <input
              type="text"
              value={newSnapshotNote}
              onChange={e => setNewSnapshotNote(e.target.value)}
              placeholder="输入该快照的更新摘要说明（例如：完成核心章节论证）..."
              className="flex-1 px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 outline-none"
              autoFocus
            />
            <button
              type="submit"
              className="px-3 py-1.5 bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 rounded-lg font-medium shrink-0"
            >
              保存快照
            </button>
            <button
              type="button"
              onClick={() => setCreatingSnapshot(false)}
              className="px-3 py-1.5 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 shrink-0"
            >
              取消
            </button>
          </form>
        )}

        {revertedSuccess && (
          <div className="p-3 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 text-xs flex items-center justify-center gap-2 font-medium shrink-0">
            <Check className="w-4 h-4" />
            <span>已成功回滚至选定版本！磁盘 Markdown 文件已自动更新。</span>
          </div>
        )}

        {errorMessage && (
          <div className="p-3 bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 text-xs flex items-center justify-between gap-2 font-medium shrink-0">
            <span className="flex-1">{errorMessage}</span>
            <button
              onClick={() => setErrorMessage(null)}
              className="px-2 py-0.5 rounded bg-rose-600 text-white"
            >
              关闭
            </button>
          </div>
        )}

        {/* Split View */}
        <div className="flex-1 grid grid-cols-1 md:grid-cols-12 min-h-0 overflow-hidden">
          {/* Left Column: Revision List */}
          <div className="md:col-span-4 border-r border-neutral-200 dark:border-neutral-800 overflow-y-auto p-3 space-y-2 bg-neutral-50/50 dark:bg-neutral-950/30">
            <div className="flex items-center justify-between text-[11px] font-semibold text-neutral-400 uppercase tracking-wider px-2 py-1">
              <span>磁盘快照记录 ({revisions.length})</span>
              <button
                onClick={loadRevisions}
                disabled={isLoading}
                className="hover:text-neutral-700 dark:hover:text-neutral-200"
                title="刷新版本"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {revisions.length === 0 ? (
              <p className="text-xs text-neutral-400 p-3">暂无历史快照</p>
            ) : (
              revisions.map((ver, idx) => {
                const isSelected = currentVersion?.id === ver.id;
                const isLatest = idx === 0;

                return (
                  <div
                    key={ver.id}
                    onClick={() => setSelectedVersionId(ver.id)}
                    className={`p-3 rounded-xl border text-xs cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-white dark:bg-neutral-900 border-purple-500 dark:border-purple-500 shadow-xs ring-1 ring-purple-500/30'
                        : 'bg-white/60 dark:bg-neutral-900/60 border-neutral-200 dark:border-neutral-800/80 hover:border-neutral-300 dark:hover:border-neutral-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-1.5">
                        v{ver.versionNumber || revisions.length - idx}
                        {isLatest && (
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300">
                            最新版本
                          </span>
                        )}
                      </span>
                      <span className="text-[11px] text-neutral-400 font-mono">
                        {new Date(ver.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>

                    <p className="text-neutral-600 dark:text-neutral-300 line-clamp-1 mb-1.5 font-medium">
                      {ver.note || '更新文档内容'}
                    </p>

                    <div className="flex items-center justify-between text-[11px] text-neutral-400">
                      <span>{new Date(ver.createdAt).toLocaleDateString('zh-CN')}</span>
                      <span className="font-mono text-[10px]">{ver.id.slice(0, 8)}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Right Column: Snapshot Markdown Content */}
          <div className="md:col-span-8 flex flex-col min-h-0 bg-white dark:bg-neutral-900">
            {currentVersion ? (
              <>
                <div className="flex items-center justify-between px-6 py-3 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-950/20 text-xs shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-neutral-800 dark:text-neutral-200">
                      版本 v{currentVersion.versionNumber || '历史'}
                    </span>
                    <span className="text-neutral-400">·</span>
                    <span className="text-neutral-500">
                      {new Date(currentVersion.createdAt).toLocaleString('zh-CN')}
                    </span>
                  </div>

                  <button
                    onClick={() => handleRevert(currentVersion)}
                    disabled={reverting}
                    className="px-3.5 py-1.5 text-xs font-medium text-white bg-neutral-900 dark:bg-neutral-100 dark:text-neutral-900 rounded-lg hover:bg-neutral-800 dark:hover:bg-neutral-200 transition-colors flex items-center gap-1.5 shadow-xs disabled:opacity-50"
                  >
                    <RotateCcw className={`w-3.5 h-3.5 ${reverting ? 'animate-spin' : ''}`} />
                    <span>{reverting ? '正在回滚...' : '一键回滚到此版本'}</span>
                  </button>
                </div>

                <div className="flex-1 p-6 overflow-y-auto">
                  <pre className="text-xs font-mono text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap leading-relaxed bg-neutral-50 dark:bg-neutral-950 p-4 rounded-xl border border-neutral-200 dark:border-neutral-800">
                    {activeSnapshotContent || '正在加载磁盘快照内容...'}
                  </pre>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-neutral-400">
                请在左侧选择版本快照以进行预览和回滚
              </div>
            )}
          </div>
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
