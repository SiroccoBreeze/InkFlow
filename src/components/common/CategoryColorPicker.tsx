import React from 'react';
import { CATEGORY_PALETTE, normalizeHexColor } from '../../services/categoryColors';

interface CategoryColorPickerProps {
  value: string;
  onChange: (color: string) => void;
}

/**
 * Preset swatches plus a native color input for category colors. The stored
 * value is always a single `#rrggbb` hex string.
 */
export const CategoryColorPicker: React.FC<CategoryColorPickerProps> = ({ value, onChange }) => {
  const current = normalizeHexColor(value) || '';

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {CATEGORY_PALETTE.map(color => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          aria-label={`选择颜色 ${color}`}
          aria-pressed={current === color}
          title={color}
          className={`w-5 h-5 rounded-full border transition-transform ${
            current === color
              ? 'ring-2 ring-offset-1 ring-neutral-900 dark:ring-white dark:ring-offset-neutral-950 scale-105'
              : 'border-black/10 dark:border-white/20 hover:scale-105'
          }`}
          style={{ backgroundColor: color }}
        />
      ))}
      <label
        className="inline-flex items-center gap-1 text-[11px] text-neutral-500 dark:text-neutral-400 cursor-pointer"
        title="自定义颜色"
      >
        <input
          type="color"
          value={current || '#64748b'}
          onChange={e => onChange(e.target.value)}
          className="w-6 h-6 p-0 bg-transparent border border-neutral-200 dark:border-neutral-700 rounded cursor-pointer"
        />
        <span className="hidden sm:inline">自定义</span>
      </label>
    </div>
  );
};
