/**
 * Reader-only image layout rules.
 *
 * Kept as plain functions so the thresholds are testable without a DOM.
 * Presentation only: nothing here modifies or re-encodes the image file.
 */

/**
 * A natural height/width ratio at or above this is treated as a "long screenshot".
 * Ordinary portraits (3:4 ≈ 1.33, 9:16 ≈ 1.78) stay below it; phone screenshots
 * (≈ 2.2) and stitched captures (3× and up) are above it.
 */
export const TALL_IMAGE_RATIO = 1.9;

/** Whether an image should be previewed with a clipped height + fade mask. */
export function isTallArticleImage(naturalWidth: number, naturalHeight: number): boolean {
  if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight)) return false;
  if (naturalWidth <= 0 || naturalHeight <= 0) return false;
  return naturalHeight / naturalWidth >= TALL_IMAGE_RATIO;
}
