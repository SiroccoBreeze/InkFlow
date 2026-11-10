import React from 'react';
import { Folder, ArrowRight, BookOpen } from 'lucide-react';
import { Category, KnowledgeDoc } from '../../types';

interface CategoryListViewProps {
  categories: Category[];
  docs: KnowledgeDoc[];
  onSelectCategory: (catName: string) => void;
  isOwner: boolean;
}

export const CategoryListView: React.FC<CategoryListViewProps> = ({
  categories,
  docs,
  onSelectCategory,
  isOwner,
}) => {
  const visibleDocs = docs.filter(d => isOwner || d.visibility === 'public');

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
          全部分类导航
        </h1>
        <p className="text-xs sm:text-sm text-neutral-500 mt-1">
          按系统化领域梳理的核心知识体系
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {categories.map(cat => {
          const catDocs = visibleDocs.filter(d => d.category === cat.name);
          const totalWords = catDocs.reduce((acc, d) => acc + (d.wordCount || 0), 0);

          return (
            <div
              key={cat.id}
              onClick={() => onSelectCategory(cat.name)}
              className="group bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-600 rounded-2xl p-6 shadow-xs hover:shadow-md transition-all cursor-pointer flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="w-10 h-10 rounded-xl bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center text-neutral-900 dark:text-neutral-100">
                    <Folder className="w-5 h-5" />
                  </div>
                  <span className="font-mono text-xs text-neutral-400">
                    {catDocs.length} 篇文档
                  </span>
                </div>

                <h3 className="text-lg font-bold text-neutral-900 dark:text-neutral-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors mb-2">
                  {cat.name}
                </h3>
                <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed line-clamp-2">
                  {cat.description}
                </p>
              </div>

              <div className="pt-6 mt-6 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-between text-xs text-neutral-500">
                <span>累积 {totalWords} 字</span>
                <span className="flex items-center gap-1 font-medium group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                  进入分类
                  <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
