import { Category } from '../types';

/**
 * Single source of truth for category colors in the frontend.
 *
 * Every category owns an explicit `color` once it has been saved; the palette
 * below is only used to assign a NEW category a color and to keep categories
 * without a stored color stable across reloads and devices.
 *
 * The palette/hash is mirrored in `server/utils/categoryColor.ts` (kept in sync
 * on purpose: the server can also auto-create a category when a document
 * introduces one).
 */
export const CATEGORY_PALETTE: string[] = [
  '#0284c7', // sky
  '#16a34a', // emerald
  '#d97706', // amber
  '#7c3aed', // violet
  '#e11d48', // rose
  '#0891b2', // cyan
  '#65a30d', // lime
  '#c026d3', // fuchsia
  '#ea580c', // orange
  '#4f46e5', // indigo
];

/** Tags are a separate node kind, never a category. */
export const TAG_NODE_COLOR = '#64748b';
export const FALLBACK_CATEGORY_COLOR = TAG_NODE_COLOR;

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Returns a normalized `#rrggbb` value, or null for empty/invalid input. */
export function normalizeHexColor(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!HEX_COLOR_RE.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  if (lower.length === 4) {
    const [r, g, b] = lower.slice(1);
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return lower;
}

/** Deterministic hash so a name without a stored color keeps the same color. */
function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function defaultColorForName(name: string): string {
  if (!name) return FALLBACK_CATEGORY_COLOR;
  return CATEGORY_PALETTE[hashName(name) % CATEGORY_PALETTE.length];
}

/**
 * Resolves the color used to paint a category. Explicit stored color wins;
 * otherwise a stable derived color keeps unknown/legacy categories from all
 * collapsing into the same grey.
 */
export function resolveCategoryColor(
  categories: Pick<Category, 'name' | 'color'>[] | undefined,
  name: string | undefined | null
): string {
  const target = (name || '').trim();
  const category = categories?.find(c => c.name === target);
  return normalizeHexColor(category?.color) || defaultColorForName(target);
}

/**
 * Color to pre-fill for a new category: its stored color when it already
 * exists, otherwise the first palette color not used by the taxonomy yet.
 */
export function pickCategoryColor(name: string, categories: Pick<Category, 'name' | 'color'>[]): string {
  const existing = normalizeHexColor(categories.find(c => c.name === name)?.color);
  if (existing) return existing;

  const used = new Set(
    categories.map(c => normalizeHexColor(c.color)).filter((c): c is string => Boolean(c))
  );
  return CATEGORY_PALETTE.find(color => !used.has(color)) || defaultColorForName(name);
}
