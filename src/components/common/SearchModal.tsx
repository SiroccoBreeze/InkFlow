import React, { useState, useEffect, useRef } from 'react';
import { Search, X, FileText, ArrowRight, Tag, Folder, Sparkles } from 'lucide-react';
import { KnowledgeDoc } from '../../types';
import { apiClient } from '../../services/apiClient';

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  docs: KnowledgeDoc[];
  onSelectDoc: (doc: KnowledgeDoc) => void;
  isOwner: boolean;
}

export const SearchModal: React.FC<SearchModalProps> = ({
  isOpen,
  onClose,
  docs,
  onSelectDoc,
  isOwner,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [ftsResults, setFtsResults] = useState<any[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setFtsResults(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Real-time backend FTS5 search with debounce
  useEffect(() => {
    const clean = query.trim();
    if (!clean) {
      setFtsResults(null);
      setIsSearching(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await apiClient.search(clean);
        if (res.data && Array.isArray(res.data)) {
          setFtsResults(res.data);
          setSelectedIndex(0);
        }
      } catch {
        // Fallback to local filtering
      } finally {
        setIsSearching(false);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [query]);

  // Filter docs by permissions: visitors only see public docs
  const visibleDocs = docs.filter(doc => isOwner || doc.visibility === 'public');

  // Local fallback results
  const localFiltered = query.trim()
    ? visibleDocs.filter(doc => {
        const q = query.toLowerCase();
        return (
          doc.title.toLowerCase().includes(q) ||
          doc.category.toLowerCase().includes(q) ||
          doc.tags.some(t => t.toLowerCase().includes(q)) ||
          doc.rawMarkdown.toLowerCase().includes(q)
        );
      })
    : visibleDocs.slice(0, 8); // show recent 8 if empty query

  // Effective results list: prefer SQLite FTS5 results if available
  const effectiveResults: KnowledgeDoc[] = (ftsResults && ftsResults.length > 0)
    ? ftsResults.map(r => {
        const matched = docs.find(d => d.id === r.id);
        if (matched) return { ...matched, snippet: r.snippet };
        return {
          id: r.id,
          slug: r.slug,
          title: r.title,
          category: r.category,
          visibility: r.visibility,
          rawMarkdown: '',
          tags: [],
          author: 'Owner',
          createdAt: r.updated_at,
          updatedAt: r.updated_at,
          wordCount: r.word_count || 0,
          readingTimeMinutes: r.reading_time || 1,
          versionCount: 1,
          pinned: Boolean(r.pinned),
          snippet: r.snippet,
        } as KnowledgeDoc & { snippet?: string };
      })
    : localFiltered;

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev < effectiveResults.length - 1 ? prev + 1 : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : effectiveResults.length - 1));
      } else if (e.key === 'Enter' && effectiveResults[selectedIndex]) {
        e.preventDefault();
        const target = effectiveResults[selectedIndex];
        const fullDoc = docs.find(d => d.id === target.id) || target;
        onSelectDoc(fullDoc);
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, effectiveResults, selectedIndex, onClose, onSelectDoc, docs]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 sm:pt-24 px-4 bg-neutral-900/40 backdrop-blur-xs">
      <div
        className="w-full max-w-2xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl shadow-2xl overflow-hidden transition-all"
        onClick={e => e.stopPropagation()}
      >
        {/* Search Input Bar */}
        <div className="flex items-center px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 gap-3">
          <Search className="w-5 h-5 text-neutral-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="搜索文档标题、正文、分类或标签 (SQLite FTS5 全文秒级匹配)..."
            className="w-full bg-transparent text-sm sm:text-base outline-none text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400"
          />
          {isSearching && (
            <div className="w-4 h-4 border-2 border-neutral-300 dark:border-neutral-700 border-t-neutral-900 dark:border-t-white rounded-full animate-spin shrink-0" />
          )}
          {query && !isSearching && (
            <button
              onClick={() => {
                setQuery('');
                setFtsResults(null);
              }}
              className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 p-1 rounded"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 shrink-0">
            ESC
          </span>
        </div>

        {/* Search Results */}
        <div className="max-h-96 overflow-y-auto divide-y divide-neutral-100 dark:divide-neutral-800/60 p-2">
          {effectiveResults.length === 0 ? (
            <div className="text-center py-12 text-sm text-neutral-500">
              未找到与 "{query}" 相关的知识文档
            </div>
          ) : (
            effectiveResults.map((doc: any, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={doc.id}
                  onClick={() => {
                    const fullDoc = docs.find(d => d.id === doc.id) || doc;
                    onSelectDoc(fullDoc);
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`flex items-start justify-between p-3 rounded-lg cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-neutral-100 dark:bg-neutral-800'
                      : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/50'
                  }`}
                >
                  <div className="flex items-start gap-3 min-w-0 pr-4 flex-1">
                    <FileText className="w-4 h-4 text-neutral-400 mt-1 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate">
                          {doc.title}
                        </h4>
                        {isOwner && (
                          <span
                            className={`text-xs px-1.5 py-0.2 rounded font-mono ${
                              doc.visibility === 'public'
                                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                                : doc.visibility === 'unlisted'
                                ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                                : 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'
                            }`}
                          >
                            {doc.visibility === 'public'
                              ? '公开'
                              : doc.visibility === 'unlisted'
                              ? '未公开'
                              : '私密'}
                          </span>
                        )}
                      </div>

                      {/* FTS Snippet Highlight */}
                      {doc.snippet && (
                        <p
                          className="text-xs text-neutral-600 dark:text-neutral-400 mt-1 font-mono line-clamp-2 leading-relaxed bg-neutral-100/50 dark:bg-neutral-950/50 p-1.5 rounded"
                          dangerouslySetInnerHTML={{
                            __html: doc.snippet.replace(
                              /<mark>/g,
                              '<span class="bg-amber-200 dark:bg-amber-900/60 text-amber-900 dark:text-amber-200 px-0.5 rounded font-semibold">'
                            ).replace(/<\/mark>/g, '</span>'),
                          }}
                        />
                      )}

                      {/* Clean Metadata */}
                      <div className="flex items-center gap-2 text-xs text-neutral-500 mt-1">
                        <span className="flex items-center gap-1">
                          <Folder className="w-3 h-3" />
                          {doc.category}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{doc.readingTimeMinutes || 1} 分钟阅读</span>
                        {doc.tags && doc.tags.length > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="flex items-center gap-1 truncate max-w-xs">
                              <Tag className="w-3 h-3" />
                              {doc.tags.join(', ')}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <ArrowRight
                    className={`w-4 h-4 text-neutral-400 shrink-0 self-center transition-opacity ${
                      isSelected ? 'opacity-100' : 'opacity-0'
                    }`}
                  />
                </div>
              );
            })
          )}
        </div>

        {/* Footer shortcuts */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-neutral-50 dark:bg-neutral-950/50 border-t border-neutral-200 dark:border-neutral-800 text-xs text-neutral-500">
          <div className="flex items-center gap-3">
            <span>
              <kbd className="px-1 py-0.5 rounded bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 font-mono">
                ↑
              </kbd>{' '}
              <kbd className="px-1 py-0.5 rounded bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 font-mono">
                ↓
              </kbd>{' '}
              切换
            </span>
            <span>
              <kbd className="px-1 py-0.5 rounded bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 font-mono">
                ↵
              </kbd>{' '}
              选择
            </span>
          </div>
          <span className="flex items-center gap-1.5 font-mono">
            <Sparkles className="w-3 h-3 text-amber-500" />
            <span>SQLite FTS5 · 共 {effectiveResults.length} 篇相关结果</span>
          </span>
        </div>
      </div>
    </div>
  );
};
