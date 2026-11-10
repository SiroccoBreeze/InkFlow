import React, { useState, useMemo } from 'react';
import {
  BookOpen,
  Tag,
  Pin,
  ArrowRight,
  X,
  MessageSquare,
  Sparkles,
  Search,
} from 'lucide-react';
import { Category, KnowledgeDoc } from '../../types';
import { storage } from '../../services/storage';
import { Pagination } from '../common/Pagination';

interface PublicPortalProps {
  docs: KnowledgeDoc[];
  categories: Category[];
  onSelectDoc: (doc: KnowledgeDoc) => void;
  onOpenSearch: () => void;
  selectedCategory: string | null;
  onSelectCategory: (category: string | null) => void;
  selectedTag: string | null;
  onSelectTag: (tag: string | null) => void;
}

const CATEGORY_COLORS: Record<string, string> = {
  '架构与系统': '#0284c7', // Sky Blue
  '前端与工程': '#16a34a', // Emerald Green
  '认知与方法论': '#d97706', // Amber Gold
  '商业与战略': '#7c3aed', // Violet Purple
  '个人复盘': '#e11d48', // Rose Red
};

export const PublicPortal: React.FC<PublicPortalProps> = ({
  docs,
  categories,
  onSelectDoc,
  selectedCategory,
  onSelectCategory,
  selectedTag,
  onSelectTag,
}) => {
  const [sortOrder, setSortOrder] = useState<'updated' | 'readingTime'>('updated');
  const [tagKeyword, setTagKeyword] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(6);

  // Public docs only
  const publicDocs = useMemo(() => docs.filter(d => d.visibility === 'public'), [docs]);

  // Aggregate tags & counts
  const tagCounts = useMemo(() => {
    return publicDocs.reduce((acc, doc) => {
      (doc.tags || []).forEach(t => {
        acc[t] = (acc[t] || 0) + 1;
      });
      return acc;
    }, {} as Record<string, number>);
  }, [publicDocs]);

  // Sorted and searched tags for sidebar selection
  const filteredTags = useMemo(() => {
    let entries = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
    if (tagKeyword.trim()) {
      const q = tagKeyword.toLowerCase();
      entries = entries.filter(([tag]) => tag.toLowerCase().includes(q));
    }
    return entries;
  }, [tagCounts, tagKeyword]);

  // Comments count cache
  const commentsCountMap = useMemo(() => {
    const map: Record<string, number> = {};
    publicDocs.forEach(d => {
      map[d.id] = storage.getComments(d.id).length;
    });
    return map;
  }, [publicDocs]);

  // Reset page to 1 when filters or sort order change
  React.useEffect(() => {
    setCurrentPage(1);
  }, [selectedCategory, selectedTag, sortOrder]);

  // Filtered and sorted documents
  const filteredDocs = useMemo(() => {
    let result = publicDocs.filter(d => {
      if (selectedCategory && d.category !== selectedCategory) return false;
      if (selectedTag && (!d.tags || !d.tags.includes(selectedTag))) return false;
      return true;
    });

    return [...result].sort((a, b) => {
      // Pinned docs first if on all
      if (!selectedCategory && !selectedTag) {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
      }

      if (sortOrder === 'updated') {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      } else {
        return b.readingTimeMinutes - a.readingTimeMinutes;
      }
    });
  }, [publicDocs, selectedCategory, selectedTag, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(filteredDocs.length / pageSize));

  // Sliced docs for current page
  const paginatedDocs = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredDocs.slice(start, start + pageSize);
  }, [filteredDocs, currentPage, pageSize]);

  const handlePageChange = (nextPage: number) => {
    setCurrentPage(nextPage);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      
      {/* 2-Column Responsive Layout: Left Sidebar + Right Feed (Eliminating empty side margins) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        
        {/* Left Column (Span 4): Personal Garden Profile, Category Tree & Tag Index */}
        <aside className="lg:col-span-4 space-y-5 lg:sticky lg:top-20">
          
          {/* Garden Intro Card */}
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl p-5 sm:p-6 shadow-xs space-y-3">
            <div className="flex items-center gap-2 text-xs text-neutral-500 font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span>数字思维花园 · InkFlow</span>
            </div>

            <h1 className="text-xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
              探索与沉淀个人知识体系
            </h1>

            <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
              本地优先架构，Markdown 为正文唯一事实来源。记录系统架构、前端工程实践与长效认知模型。
            </p>

            <div className="pt-2 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-between text-xs text-neutral-400 font-mono">
              <span>{publicDocs.length} 篇公开笔记</span>
              <span>·</span>
              <span>{categories.length} 个分类</span>
              <span>·</span>
              <span>{Object.keys(tagCounts).length} 个标签</span>
            </div>
          </div>

          {/* Category Navigation Tree */}
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl p-5 shadow-xs space-y-3">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-neutral-400">
              <span>领域分类</span>
              <span className="font-mono text-[11px] font-normal text-neutral-400">{categories.length} 领域</span>
            </div>

            <div className="space-y-1">
              <button
                onClick={() => onSelectCategory(null)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                  selectedCategory === null
                    ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 shadow-xs'
                    : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                }`}
              >
                <span>全部领域</span>
                <span className="font-mono text-[11px] opacity-75">{publicDocs.length}</span>
              </button>

              {categories.map(cat => {
                const isSelected = selectedCategory === cat.name;
                const count = publicDocs.filter(d => d.category === cat.name).length;
                const dotColor = CATEGORY_COLORS[cat.name] || '#64748b';

                return (
                  <button
                    key={cat.id}
                    onClick={() => onSelectCategory(isSelected ? null : cat.name)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                      isSelected
                        ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 shadow-xs'
                        : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dotColor }} />
                      <span className="truncate">{cat.name}</span>
                    </div>
                    <span className="font-mono text-[11px] opacity-75 shrink-0 ml-2">
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Knowledge Tags Directory */}
          {Object.keys(tagCounts).length > 0 && (
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl p-5 shadow-xs space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold uppercase tracking-wider text-neutral-400 text-[11px]">
                  知识标签 ({filteredTags.length})
                </span>
                {selectedTag && (
                  <button
                    onClick={() => onSelectTag(null)}
                    className="text-[11px] text-neutral-400 hover:text-rose-500 transition-colors"
                  >
                    清除标签
                  </button>
                )}
              </div>

              {/* Tag Quick Filter if many tags */}
              {Object.keys(tagCounts).length > 6 && (
                <div className="relative">
                  <input
                    type="text"
                    value={tagKeyword}
                    onChange={e => setTagKeyword(e.target.value)}
                    placeholder="过滤标签..."
                    className="w-full px-2.5 py-1 text-xs bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg outline-none text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400"
                  />
                  {tagKeyword && (
                    <button
                      onClick={() => setTagKeyword('')}
                      className="absolute right-2 top-1 text-neutral-400 hover:text-neutral-600"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-1.5 max-h-48 overflow-y-auto pr-1">
                {filteredTags.map(([tag, count]) => {
                  const isSelected = selectedTag === tag;
                  return (
                    <button
                      key={tag}
                      onClick={() => onSelectTag(isSelected ? null : tag)}
                      className={`px-2.5 py-1 rounded-md font-mono text-[11px] transition-colors flex items-center gap-1 ${
                        isSelected
                          ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 font-semibold shadow-2xs'
                          : 'bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-400 hover:border-neutral-400 dark:hover:border-neutral-600'
                      }`}
                    >
                      <span>#{tag}</span>
                      <span className="opacity-60 text-[10px]">({count})</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

        </aside>

        {/* Right Main Column (Span 8): Article Feed & Toolbar */}
        <main className="lg:col-span-8 space-y-4">
          
          {/* Top Filter Feedback Bar & Sorter (No duplicate search box) */}
          <div className="flex items-center justify-between gap-3 px-1 py-1 text-xs text-neutral-500">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-neutral-800 dark:text-neutral-200">
                {selectedCategory || selectedTag ? '筛选结果' : '全部文献'} ({filteredDocs.length})
              </span>

              {selectedCategory && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-200 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 font-medium">
                  <span>分类: {selectedCategory}</span>
                  <button onClick={() => onSelectCategory(null)} className="hover:text-rose-500">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}

              {selectedTag && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-200 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 font-mono font-medium">
                  <span>#{selectedTag}</span>
                  <button onClick={() => onSelectTag(null)} className="hover:text-rose-500">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}

              {(selectedCategory || selectedTag) && (
                <button
                  onClick={() => {
                    onSelectCategory(null);
                    onSelectTag(null);
                  }}
                  className="text-neutral-400 hover:text-neutral-900 dark:hover:text-white underline ml-1"
                >
                  重置
                </button>
              )}
            </div>

            {/* Sorter */}
            <div className="flex items-center gap-1 shrink-0 text-neutral-400">
              <select
                value={sortOrder}
                onChange={e => setSortOrder(e.target.value as any)}
                className="bg-transparent border-0 text-xs text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white outline-none cursor-pointer"
              >
                <option value="updated">最新更新</option>
                <option value="readingTime">阅读时长</option>
              </select>
            </div>
          </div>

          {/* Article Feed Cards */}
          {filteredDocs.length === 0 ? (
            <div className="text-center py-20 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl p-8">
              <BookOpen className="w-8 h-8 text-neutral-300 dark:text-neutral-700 mx-auto mb-3" />
              <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
                暂未找到匹配的知识文献
              </h3>
              <p className="text-xs text-neutral-500 mt-1">
                尝试在左侧侧栏取消分类或标签限制，或使用顶栏 ⌘K 快捷键搜索。
              </p>
              <button
                onClick={() => {
                  onSelectCategory(null);
                  onSelectTag(null);
                }}
                className="mt-4 px-3.5 py-1.5 text-xs bg-neutral-100 dark:bg-neutral-800 rounded-lg text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700"
              >
                清空筛选
              </button>
            </div>
          ) : (
            <>
              <div className="space-y-3.5">
                {paginatedDocs.map(doc => {
                  const dotColor = CATEGORY_COLORS[doc.category] || '#64748b';
                  const commentsCount = commentsCountMap[doc.id] || 0;

                  // Clean text snippet for reading preview
                  const cleanText = doc.rawMarkdown
                    .replace(/^---[\s\S]*?---/, '')
                    .replace(/^#+.*$/gm, '')
                    .replace(/[`*_[\]()#]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                  const snippet = cleanText.slice(0, 140) + '...';

                  return (
                    <article
                      key={doc.id}
                      onClick={() => onSelectDoc(doc)}
                      className="group p-5 sm:p-6 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-600 rounded-2xl transition-all cursor-pointer shadow-2xs hover:shadow-xs space-y-2.5"
                    >
                      {/* Header line */}
                      <div className="flex items-center justify-between text-xs text-neutral-500 flex-wrap gap-2">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dotColor }} />
                          <span className="font-medium text-neutral-700 dark:text-neutral-300">{doc.category}</span>
                          <span aria-hidden="true" className="text-neutral-300 dark:text-neutral-700">·</span>
                          <span>{new Date(doc.updatedAt).toLocaleDateString('zh-CN')}</span>
                          <span aria-hidden="true" className="text-neutral-300 dark:text-neutral-700">·</span>
                          <span className="font-mono tabular-nums">{doc.wordCount} 字</span>
                          <span aria-hidden="true" className="text-neutral-300 dark:text-neutral-700">·</span>
                          <span>约 {doc.readingTimeMinutes} 分钟</span>
                        </div>

                        {doc.pinned && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/60 px-2 py-0.5 rounded-full">
                            <Pin className="w-3 h-3 rotate-45" />
                            <span>置顶推荐</span>
                          </span>
                        )}
                      </div>

                      {/* Title */}
                      <h2 className="text-lg sm:text-xl font-bold text-neutral-900 dark:text-neutral-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors leading-snug">
                        {doc.title}
                      </h2>

                      {/* Excerpt */}
                      <p className="text-xs sm:text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed line-clamp-2">
                        {snippet}
                      </p>

                      {/* Tags and Discussion count */}
                      <div className="pt-2 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {doc.tags && doc.tags.map(t => (
                            <span
                              key={t}
                              className="font-mono text-[11px] text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                              onClick={e => {
                                e.stopPropagation();
                                onSelectTag(t);
                              }}
                            >
                              #{t}
                            </span>
                          ))}
                        </div>

                        <div className="flex items-center gap-3 text-neutral-400 group-hover:text-neutral-700 dark:group-hover:text-neutral-300 transition-colors shrink-0 ml-2">
                          {commentsCount > 0 && (
                            <span className="flex items-center gap-1 text-[11px] font-mono">
                              <MessageSquare className="w-3 h-3" />
                              <span>{commentsCount}</span>
                            </span>
                          )}
                          <span className="text-xs font-medium flex items-center gap-0.5 group-hover:text-blue-600 dark:group-hover:text-blue-400">
                            <span>阅读</span>
                            <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                          </span>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>

              {/* Pagination Bar */}
              <div className="pt-2">
                <Pagination
                  currentPage={currentPage}
                  totalPages={totalPages}
                  totalItems={filteredDocs.length}
                  pageSize={pageSize}
                  pageSizeOptions={[6, 10, 20]}
                  onPageChange={handlePageChange}
                  onPageSizeChange={newSize => {
                    setPageSize(newSize);
                    setCurrentPage(1);
                  }}
                />
              </div>
            </>
          )}

        </main>
      </div>

    </div>
  );
};
