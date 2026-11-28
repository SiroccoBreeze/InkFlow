/**
 * Server-side category color helpers.
 *
 * Mirrors `src/services/categoryColors.ts` (palette + hash) so a category that
 * the server auto-creates while saving a document gets the same stable color the
 * browser would assign to it. Keep the two files in sync.
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

export const FALLBACK_CATEGORY_COLOR = '#64748b';

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

function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function defaultCategoryColor(name: string): string {
  if (!name) return FALLBACK_CATEGORY_COLOR;
  return CATEGORY_PALETTE[hashName(name) % CATEGORY_PALETTE.length];
}
