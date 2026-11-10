import React, { useState } from 'react';
import { MessageSquare, ThumbsUp, Pin, Trash2, Send, ShieldCheck, UserCheck, User } from 'lucide-react';
import { CommentItem, UserSession } from '../../types';
import { storage } from '../../services/storage';
import { ConfirmModal } from '../common/ConfirmModal';

interface DocCommentsProps {
  docId: string;
  session: UserSession;
  isOwner: boolean;
}

export const DocComments: React.FC<DocCommentsProps> = ({
  docId,
  session,
  isOwner,
}) => {
  const [comments, setComments] = useState<CommentItem[]>(() => storage.getComments(docId));
  const [newCommentText, setNewCommentText] = useState('');
  const [customAuthorName, setCustomAuthorName] = useState(session.username);
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

  const refreshComments = () => {
    setComments([...storage.getComments(docId)]);
  };

  const handleAddComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCommentText.trim()) return;

    storage.addComment({
      docId,
      authorName: customAuthorName.trim() || session.username,
      authorRole: session.role,
      content: newCommentText.trim(),
    });

    setNewCommentText('');
    refreshComments();
  };

  const handleUpvote = (id: string) => {
    storage.upvoteComment(id);
    refreshComments();
  };

  const handleDelete = (id: string) => {
    setConfirmModal({
      isOpen: true,
      title: '删除读者留言',
      message: '确定要彻底删除此条研讨留言吗？删除后不可恢复。',
      confirmText: '删除留言',
      cancelText: '取消',
      isDestructive: true,
      type: 'danger',
      onConfirm: () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        storage.deleteComment(id);
        refreshComments();
      },
    });
  };

  return (
    <section className="mt-12 pt-8 border-t border-neutral-200 dark:border-neutral-800 space-y-6">
      
      {/* Section Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-neutral-500" />
          <h3 className="text-lg font-bold text-neutral-900 dark:text-neutral-100">
            读者研讨与批注 ({comments.length})
          </h3>
        </div>
        <span className="text-xs text-neutral-400">
          支持 Markdown 语法交流
        </span>
      </div>

      {/* Add Comment Input Form */}
      <form onSubmit={handleAddComment} className="p-4 rounded-xl bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 space-y-3">
        <div className="flex items-center justify-between text-xs text-neutral-500 pb-1">
          <div className="flex items-center gap-2">
            <span>发表身份：</span>
            <input
              type="text"
              value={customAuthorName}
              onChange={e => setCustomAuthorName(e.target.value)}
              placeholder="您的昵称"
              className="px-2 py-1 rounded bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 text-xs text-neutral-800 dark:text-neutral-200 outline-none w-44"
            />
            <span className="text-[11px] text-neutral-400 font-mono">
              [{session.role === 'owner' ? '站长' : session.role === 'contributor' ? '共创者' : '读者'}]
            </span>
          </div>
        </div>

        <textarea
          value={newCommentText}
          onChange={e => setNewCommentText(e.target.value)}
          placeholder="撰写你的思考、疑问或补充观点（支持 Markdown 引用与代码块）..."
          rows={3}
          className="w-full p-3 rounded-lg text-xs font-mono bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 outline-none focus:border-neutral-900 dark:focus:border-neutral-200 resize-y"
        />

        <div className="flex items-center justify-end">
          <button
            type="submit"
            className="px-4 py-1.5 text-xs font-semibold text-white bg-neutral-900 dark:bg-white dark:text-neutral-900 hover:opacity-90 rounded-lg transition-opacity flex items-center gap-1.5 shadow-xs"
          >
            <Send className="w-3.5 h-3.5" />
            <span>提交批注思考</span>
          </button>
        </div>
      </form>

      {/* Comments Stream */}
      <div className="space-y-3">
        {comments.length === 0 ? (
          <div className="text-center py-8 text-xs text-neutral-400">
            暂无读者留言，欢迎成为第一个留下思考的人！
          </div>
        ) : (
          comments.map(c => (
            <div
              key={c.id}
              className={`p-4 rounded-xl border text-xs transition-colors ${
                c.isPinned
                  ? 'bg-amber-50/40 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900/50'
                  : 'bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center text-neutral-700 dark:text-neutral-300">
                    {c.authorRole === 'owner' ? (
                      <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
                    ) : c.authorRole === 'contributor' ? (
                      <UserCheck className="w-3.5 h-3.5 text-emerald-600" />
                    ) : (
                      <User className="w-3.5 h-3.5" />
                    )}
                  </div>

                  <span className="font-semibold text-neutral-900 dark:text-neutral-100">
                    {c.authorName}
                  </span>

                  {c.authorRole === 'owner' && (
                    <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
                      作者 / 站长
                    </span>
                  )}
                  {c.authorRole === 'contributor' && (
                    <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                      共创者
                    </span>
                  )}
                  {c.isPinned && (
                    <span className="flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400 font-medium">
                      <Pin className="w-3 h-3" />
                      置顶
                    </span>
                  )}
                </div>

                <span className="text-[11px] text-neutral-400">
                  {new Date(c.createdAt).toLocaleDateString('zh-CN')}
                </span>
              </div>

              {/* Comment Content */}
              <p className="text-neutral-700 dark:text-neutral-300 leading-relaxed whitespace-pre-wrap pl-8">
                {c.content}
              </p>

              {/* Footer actions */}
              <div className="flex items-center justify-between pt-3 mt-2 pl-8 border-t border-neutral-100 dark:border-neutral-800/60 text-neutral-400">
                <button
                  onClick={() => handleUpvote(c.id)}
                  className="flex items-center gap-1.5 text-neutral-500 hover:text-neutral-900 dark:hover:text-white transition-colors"
                >
                  <ThumbsUp className="w-3.5 h-3.5" />
                  <span className="font-mono text-[11px]">认可 ({c.upvotes || 0})</span>
                </button>

                {isOwner && (
                  <button
                    onClick={() => handleDelete(c.id)}
                    className="p-1 hover:text-rose-600 transition-colors"
                    title="删除此留言"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
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
    </section>
  );
};
