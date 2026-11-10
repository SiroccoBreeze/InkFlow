import React from 'react';
import { Tag, ArrowRight } from 'lucide-react';
import { KnowledgeDoc } from '../../types';

interface TagListViewProps {
  docs: KnowledgeDoc[];
  onSelectTag: (tagName: string) => void;
  isOwner: boolean;
}

export const TagListView: React.FC<TagListViewProps> = ({
  docs,
  onSelectTag,
  isOwner,
}) => {
  const visibleDocs = docs.filter(
    d => isOwner || (d.visibility === 'public' && (d.status ?? 'published') === 'published')
  );

  // Compute tag occurrences and docs list
  const tagMap = visibleDocs.reduce((acc, doc) => {
    (doc.tags || []).forEach(t => {
      if (!acc[t]) acc[t] = [];
      acc[t].push(doc);
    });
    return acc;
  }, {} as Record<string, KnowledgeDoc[]>);

  const sortedTags = Object.entries(tagMap).sort((a, b) => b[1].length - a[1].length);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
          知识标签索引
        </h1>
        <p className="text-xs sm:text-sm text-neutral-500 mt-1">
          穿透分类层级的交叉知识网络，点击任意标签查看聚合内容
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {sortedTags.map(([tag, tagDocs]) => (
          <div
            key={tag}
            onClick={() => onSelectTag(tag)}
            className="group bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-600 rounded-xl p-5 shadow-xs hover:shadow-md transition-all cursor-pointer flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-base font-bold text-neutral-900 dark:text-neutral-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                  #{tag}
                </span>
                <span className="font-mono text-xs text-neutral-400">
                  {tagDocs.length} 篇
                </span>
              </div>

              <div className="text-xs text-neutral-500 line-clamp-2 space-y-0.5">
                {tagDocs.slice(0, 2).map(d => (
                  <p key={d.id} className="truncate">• {d.title}</p>
                ))}
              </div>
            </div>

            <div className="pt-3 mt-3 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-end text-xs text-neutral-400 group-hover:text-blue-600 dark:group-hover:text-blue-400 font-medium">
              <span>探索全部</span>
              <ArrowRight className="w-3.5 h-3.5 ml-1 group-hover:translate-x-0.5 transition-transform" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
