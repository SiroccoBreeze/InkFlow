import React, { useState } from 'react';
import {
  MessageSquare,
  Plus,
  ThumbsUp,
  CheckCircle2,
  Pin,
  Tag,
  Search,
  Filter,
  ArrowLeft,
  Send,
  Sparkles,
  HelpCircle,
  Lightbulb,
  Radio,
  Check,
} from 'lucide-react';
import { ForumReply, ForumTopic, UserSession } from '../../types';
import { storage } from '../../services/storage';
import { renderMarkdown } from '../../services/markdown';

interface KnowledgeForumProps {
  session: UserSession;
}

export const KnowledgeForum: React.FC<KnowledgeForumProps> = ({ session }) => {
  const [topics, setTopics] = useState<ForumTopic[]>(() => storage.getForumTopics());
  const [activeCategory, setActiveCategory] = useState<'all' | 'rfc' | 'qa' | 'discussion' | 'changelog'>('all');
  const [selectedTopic, setSelectedTopic] = useState<ForumTopic | null>(null);
  const [replies, setReplies] = useState<ForumReply[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  // New topic modal
  const [isCreatingTopic, setIsCreatingTopic] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState<'rfc' | 'qa' | 'discussion' | 'changelog'>('discussion');
  const [newContent, setNewContent] = useState('');
  const [newTags, setNewTags] = useState('');

  // Reply form
  const [replyContent, setReplyContent] = useState('');

  const refreshTopics = () => {
    setTopics([...storage.getForumTopics()]);
    if (selectedTopic) {
      const updated = storage.getForumTopicById(selectedTopic.id);
      if (updated) setSelectedTopic(updated);
      setReplies([...storage.getForumReplies(selectedTopic.id)]);
    }
  };

  const handleOpenTopic = (topic: ForumTopic) => {
    setSelectedTopic(topic);
    setReplies([...storage.getForumReplies(topic.id)]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCreateTopic = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) return;

    const tags = newTags
      .split(/[,，]/)
      .map(t => t.trim())
      .filter(Boolean);

    const created = storage.createForumTopic({
      title: newTitle.trim(),
      category: newCategory,
      content: newContent.trim(),
      authorName: session.username,
      authorRole: session.role,
      tags,
    });

    setIsCreatingTopic(false);
    setNewTitle('');
    setNewContent('');
    setNewTags('');
    refreshTopics();
    handleOpenTopic(created);
  };

  const handleAddReply = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTopic || !replyContent.trim()) return;

    storage.addForumReply({
      topicId: selectedTopic.id,
      authorName: session.username,
      authorRole: session.role,
      content: replyContent.trim(),
    });

    setReplyContent('');
    refreshTopics();
  };

  const handleUpvoteTopic = (topicId: string) => {
    storage.upvoteTopic(topicId);
    refreshTopics();
  };

  const handleToggleResolved = (topicId: string) => {
    storage.toggleTopicResolved(topicId);
    refreshTopics();
  };

  const categoryMeta = {
    rfc: { label: '💡 RFC 提案', color: 'text-purple-600 dark:text-purple-400' },
    qa: { label: '❓ 技术问答', color: 'text-emerald-600 dark:text-emerald-400' },
    discussion: { label: '💬 深度研讨', color: 'text-blue-600 dark:text-blue-400' },
    changelog: { label: '📢 系统公告', color: 'text-amber-600 dark:text-amber-400' },
  };

  // Filter topics
  const filteredTopics = topics.filter(t => {
    if (activeCategory !== 'all' && t.category !== activeCategory) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        t.title.toLowerCase().includes(q) ||
        t.content.toLowerCase().includes(q) ||
        t.tags.some(tag => tag.toLowerCase().includes(q))
      );
    }
    return true;
  });

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      
      {/* If in Topic Detail View */}
      {selectedTopic ? (
        <div className="space-y-6">
          <button
            onClick={() => setSelectedTopic(null)}
            className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-white transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>返回论坛广场</span>
          </button>

          {/* Topic Main Card */}
          <article className="p-6 sm:p-8 rounded-2xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-xs space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-500">
              <div className="flex items-center gap-2">
                <span className={`font-semibold ${categoryMeta[selectedTopic.category].color}`}>
                  {categoryMeta[selectedTopic.category].label}
                </span>
                <span aria-hidden="true">·</span>
                <span>{selectedTopic.authorName}</span>
                <span aria-hidden="true">·</span>
                <span>{new Date(selectedTopic.createdAt).toLocaleDateString('zh-CN')}</span>
              </div>

              <div className="flex items-center gap-2">
                {selectedTopic.category === 'qa' && (
                  <button
                    onClick={() => handleToggleResolved(selectedTopic.id)}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs transition-colors ${
                      selectedTopic.isResolved
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                        : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-500 hover:text-neutral-900'
                    }`}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{selectedTopic.isResolved ? '已解决' : '标记已解决'}</span>
                  </button>
                )}

                <button
                  onClick={() => handleUpvoteTopic(selectedTopic.id)}
                  className="flex items-center gap-1.5 px-3 py-1 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 rounded-lg text-xs font-mono transition-colors"
                >
                  <ThumbsUp className="w-3.5 h-3.5" />
                  <span>认可 ({selectedTopic.upvotes})</span>
                </button>
              </div>
            </div>

            <h1 className="text-xl sm:text-2xl font-bold text-neutral-900 dark:text-neutral-100">
              {selectedTopic.title}
            </h1>

            {/* Markdown Body */}
            <div
              className="markdown-body pt-2"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedTopic.content) }}
            />

            {/* Tags */}
            {selectedTopic.tags.length > 0 && (
              <div className="flex items-center gap-2 pt-4 border-t border-neutral-100 dark:border-neutral-800 text-xs text-neutral-400">
                <span>标签：</span>
                {selectedTopic.tags.map(tag => (
                  <span key={tag} className="font-mono text-neutral-600 dark:text-neutral-400">
                    #{tag}
                  </span>
                ))}
              </div>
            )}
          </article>

          {/* Replies Section */}
          <section className="space-y-4">
            <h3 className="text-base font-bold text-neutral-900 dark:text-neutral-100">
              讨论回复 ({replies.length})
            </h3>

            {/* Reply Input */}
            <form onSubmit={handleAddReply} className="p-4 rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 space-y-3">
              <div className="text-xs text-neutral-500">
                以 <strong>{session.username}</strong> 身份参与讨论
              </div>
              <textarea
                value={replyContent}
                onChange={e => setReplyContent(e.target.value)}
                placeholder="分享你的见解、方案或补充参考..."
                rows={3}
                className="w-full p-3 rounded-lg text-xs font-mono bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 outline-none resize-y"
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  className="px-4 py-1.5 text-xs font-semibold text-white bg-neutral-900 dark:bg-white dark:text-neutral-900 rounded-lg shadow-xs flex items-center gap-1.5"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>发布回复</span>
                </button>
              </div>
            </form>

            {/* Replies List */}
            <div className="space-y-3">
              {replies.map(r => (
                <div
                  key={r.id}
                  className="p-4 rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-xs space-y-2"
                >
                  <div className="flex items-center justify-between text-neutral-500">
                    <span className="font-semibold text-neutral-900 dark:text-neutral-100">
                      {r.authorName}
                    </span>
                    <span className="text-[11px] text-neutral-400">
                      {new Date(r.createdAt).toLocaleDateString('zh-CN')}
                    </span>
                  </div>
                  <p className="text-neutral-700 dark:text-neutral-300 leading-relaxed whitespace-pre-wrap">
                    {r.content}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : (
        /* Forum Overview & List */
        <div className="space-y-6">
          
          {/* Header & New Topic Trigger */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-neutral-200 dark:border-neutral-800">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
                <Radio className="w-6 h-6 text-purple-600 dark:text-purple-400" />
                <span>知识共创广场 (Knowledge Forum)</span>
              </h1>
              <p className="text-xs text-neutral-500 mt-1">
                多用户知识共创社区：RFC 提案研讨、深度技术问答与系统演进公告
              </p>
            </div>

            <button
              onClick={() => setIsCreatingTopic(true)}
              className="px-4 py-2 text-xs font-semibold text-white bg-neutral-900 dark:bg-white dark:text-neutral-900 hover:opacity-90 rounded-lg transition-opacity flex items-center gap-1.5 shadow-xs shrink-0"
            >
              <Plus className="w-4 h-4" />
              <span>发起新议题 / 提案</span>
            </button>
          </div>

          {/* Category Tabs & Search Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
              <button
                onClick={() => setActiveCategory('all')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                  activeCategory === 'all'
                    ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                    : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
                }`}
              >
                全部议题 ({topics.length})
              </button>
              <button
                onClick={() => setActiveCategory('rfc')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                  activeCategory === 'rfc'
                    ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                    : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
                }`}
              >
                💡 RFC 提案
              </button>
              <button
                onClick={() => setActiveCategory('qa')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                  activeCategory === 'qa'
                    ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                    : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
                }`}
              >
                ❓ 技术问答
              </button>
              <button
                onClick={() => setActiveCategory('discussion')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                  activeCategory === 'discussion'
                    ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                    : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
                }`}
              >
                💬 深度研讨
              </button>
              <button
                onClick={() => setActiveCategory('changelog')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                  activeCategory === 'changelog'
                    ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                    : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
                }`}
              >
                📢 系统公告
              </button>
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-neutral-400 absolute left-2.5 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="搜索讨论主题..."
                className="pl-8 pr-3 py-1.5 bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg text-xs outline-none w-52"
              />
            </div>
          </div>

          {/* Topics List */}
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl overflow-hidden shadow-xs">
            {filteredTopics.length === 0 ? (
              <div className="text-center py-16 text-xs text-neutral-400">
                暂无匹配的讨论主题
              </div>
            ) : (
              filteredTopics.map(topic => (
                <div
                  key={topic.id}
                  onClick={() => handleOpenTopic(topic)}
                  className="p-5 sm:p-6 hover:bg-neutral-50/80 dark:hover:bg-neutral-800/50 transition-colors cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div className="space-y-1.5 min-w-0 pr-4">
                    <div className="flex items-center gap-2">
                      <span className={`text-[11px] font-semibold ${categoryMeta[topic.category].color}`}>
                        {categoryMeta[topic.category].label}
                      </span>
                      {topic.pinned && (
                        <span className="flex items-center gap-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                          <Pin className="w-3 h-3" />
                          置顶
                        </span>
                      )}
                      {topic.isResolved && (
                        <span className="flex items-center gap-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="w-3 h-3" />
                          已解答
                        </span>
                      )}
                    </div>

                    <h3 className="text-base font-bold text-neutral-900 dark:text-neutral-100 truncate">
                      {topic.title}
                    </h3>

                    {/* Unboxed Metadata */}
                    <div className="flex items-center gap-2 text-xs text-neutral-500">
                      <span>{topic.authorName}</span>
                      <span aria-hidden="true">·</span>
                      <span>{new Date(topic.createdAt).toLocaleDateString('zh-CN')}</span>
                      {topic.tags.length > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="truncate">#{topic.tags.join(' #')}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Counters */}
                  <div className="flex items-center gap-4 text-xs font-mono text-neutral-500 shrink-0 self-end sm:self-auto">
                    <div className="flex items-center gap-1">
                      <ThumbsUp className="w-3.5 h-3.5" />
                      <span>{topic.upvotes}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <MessageSquare className="w-3.5 h-3.5" />
                      <span>{topic.replyCount} 回复</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

        </div>
      )}

      {/* New Topic Modal */}
      {isCreatingTopic && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-neutral-900/50 backdrop-blur-xs">
          <div
            className="w-full max-w-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl p-6 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold text-neutral-900 dark:text-neutral-100">
              发起新知识议题或 RFC 提案
            </h3>

            <form onSubmit={handleCreateTopic} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  所属板块
                </label>
                <select
                  value={newCategory}
                  onChange={e => setNewCategory(e.target.value as any)}
                  className="w-full px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg outline-none"
                >
                  <option value="discussion">💬 深度研讨 (Discussion)</option>
                  <option value="rfc">💡 RFC 观点提案 (RFC / Proposal)</option>
                  <option value="qa">❓ 技术问答 (Q&A)</option>
                  {session.isOwner && (
                    <option value="changelog">📢 系统公告 (Changelog)</option>
                  )}
                </select>
              </div>

              <div>
                <label className="block font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  议题标题
                </label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  placeholder="简洁有力的议题核心标题..."
                  className="w-full px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg outline-none"
                  required
                />
              </div>

              <div>
                <label className="block font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  详细描述 (支持 Markdown 语法)
                </label>
                <textarea
                  value={newContent}
                  onChange={e => setNewContent(e.target.value)}
                  placeholder="详述你的思考脉络、代码细节或问题复现背景..."
                  rows={5}
                  className="w-full p-3 font-mono bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg outline-none resize-y"
                  required
                />
              </div>

              <div>
                <label className="block font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  标签 (逗号分隔)
                </label>
                <input
                  type="text"
                  value={newTags}
                  onChange={e => setNewTags(e.target.value)}
                  placeholder="CRDT, 分布式, 实践"
                  className="w-full px-3 py-2 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsCreatingTopic(false)}
                  className="px-4 py-2 text-xs font-medium text-neutral-600 dark:text-neutral-300"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold text-white bg-neutral-900 dark:bg-white dark:text-neutral-900 rounded-lg shadow-xs"
                >
                  立即发布
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
