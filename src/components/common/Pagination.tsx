import React, { useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';

export interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  className?: string;
  showQuickJumper?: boolean;
  showSizeChanger?: boolean;
}

export const Pagination: React.FC<PaginationProps> = ({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  pageSizeOptions = [10, 20, 50, 100],
  onPageChange,
  onPageSizeChange,
  className = '',
  showQuickJumper = true,
  showSizeChanger = true,
}) => {
  const [jumpInput, setJumpInput] = useState('');

  if (totalPages <= 1 && totalItems <= pageSize && !showSizeChanger) {
    return null;
  }

  const startItem = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, totalItems);

  // Generate page numbers with ellipses
  const getPageNumbers = () => {
    const pages: (number | '...')[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
      return pages;
    }

    pages.push(1);
    if (currentPage > 3) {
      pages.push('...');
    }

    const start = Math.max(2, currentPage - 1);
    const end = Math.min(totalPages - 1, currentPage + 1);

    for (let i = start; i <= end; i++) {
      pages.push(i);
    }

    if (currentPage < totalPages - 2) {
      pages.push('...');
    }

    pages.push(totalPages);
    return pages;
  };

  const handleJump = (e: React.FormEvent) => {
    e.preventDefault();
    const target = parseInt(jumpInput, 10);
    if (!isNaN(target) && target >= 1 && target <= totalPages) {
      onPageChange(target);
      setJumpInput('');
    }
  };

  return (
    <div
      className={`flex flex-col sm:flex-row items-center justify-between gap-4 py-3 text-xs text-neutral-600 dark:text-neutral-400 select-none ${className}`}
    >
      {/* Left: Summary text */}
      <div className="flex items-center gap-2 font-mono text-[11px] text-neutral-500 order-2 sm:order-1">
        <span>
          显示 <strong className="text-neutral-800 dark:text-neutral-200">{startItem}</strong> -{' '}
          <strong className="text-neutral-800 dark:text-neutral-200">{endItem}</strong> 条
        </span>
        <span>·</span>
        <span>
          共 <strong className="text-neutral-800 dark:text-neutral-200 font-bold">{totalItems}</strong> 项
        </span>
      </div>

      {/* Right / Center: Navigation controls */}
      <div className="flex flex-wrap items-center gap-1.5 order-1 sm:order-2">
        {/* Page size selector */}
        {showSizeChanger && onPageSizeChange && (
          <div className="flex items-center gap-1 mr-2">
            <select
              value={pageSize}
              onChange={e => {
                const nextSize = Number(e.target.value);
                onPageSizeChange(nextSize);
              }}
              className="bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 rounded-lg px-2 py-1 text-xs outline-none cursor-pointer hover:border-neutral-400 dark:hover:border-neutral-600 transition-colors"
            >
              {pageSizeOptions.map(opt => (
                <option key={opt} value={opt}>
                  {opt} 条 / 页
                </option>
              ))}
            </select>
          </div>
        )}

        {/* First Page */}
        <button
          onClick={() => onPageChange(1)}
          disabled={currentPage <= 1}
          className="p-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
          title="第一页"
        >
          <ChevronsLeft className="w-3.5 h-3.5" />
        </button>

        {/* Previous Page */}
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1}
          className="p-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
          title="上一页"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>

        {/* Page Numbers */}
        <div className="flex items-center gap-1">
          {getPageNumbers().map((page, idx) => {
            if (page === '...') {
              return (
                <span
                  key={`ellipsis-${idx}`}
                  className="px-2 py-1 text-neutral-400 font-mono text-[11px]"
                >
                  …
                </span>
              );
            }

            const isCurrent = page === currentPage;
            return (
              <button
                key={page}
                onClick={() => onPageChange(page)}
                className={`min-w-7 h-7 px-1.5 rounded-lg font-mono text-xs font-semibold transition-all ${
                  isCurrent
                    ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 shadow-xs'
                    : 'text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800/80 border border-neutral-200/70 dark:border-neutral-800'
                }`}
              >
                {page}
              </button>
            );
          })}
        </div>

        {/* Next Page */}
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages}
          className="p-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
          title="下一页"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>

        {/* Last Page */}
        <button
          onClick={() => onPageChange(totalPages)}
          disabled={currentPage >= totalPages}
          className="p-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
          title="最后一页"
        >
          <ChevronsRight className="w-3.5 h-3.5" />
        </button>

        {/* Quick jump to page */}
        {showQuickJumper && totalPages > 1 && (
          <form onSubmit={handleJump} className="hidden md:flex items-center gap-1 ml-2 text-xs">
            <span className="text-neutral-400">跳至</span>
            <input
              type="text"
              value={jumpInput}
              onChange={e => setJumpInput(e.target.value.replace(/\D/g, ''))}
              placeholder={`${currentPage}`}
              className="w-10 px-1.5 py-1 text-center font-mono text-xs bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg outline-none focus:border-neutral-400 dark:focus:border-neutral-600 text-neutral-800 dark:text-neutral-200"
            />
            <span className="text-neutral-400">页</span>
          </form>
        )}
      </div>
    </div>
  );
};
