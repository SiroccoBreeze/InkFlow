import { describe, it, expect } from 'vitest';
import { isTallArticleImage, TALL_IMAGE_RATIO } from '../../src/services/articleImageLayout';

/**
 * The reader caps every image's height, and long screenshots additionally get a
 * clipped preview + fade. These tests lock down which natural aspect ratios are
 * treated as a "long screenshot" so ordinary portrait/landscape images keep
 * being shown naturally instead of being clipped.
 */
describe('Article reader image layout classification', () => {
  it('treats normal landscape images as regular', () => {
    expect(isTallArticleImage(1600, 900)).toBe(false); // 16:9
    expect(isTallArticleImage(2400, 900)).toBe(false); // wide flowchart
    expect(isTallArticleImage(3840, 2160)).toBe(false); // 4K HD
  });

  it('treats normal portrait images as regular', () => {
    expect(isTallArticleImage(1200, 1600)).toBe(false); // 3:4 portrait photo
    expect(isTallArticleImage(1080, 1920)).toBe(false); // 9:16 vertical video frame
  });

  it('treats long phone screenshots as tall', () => {
    expect(isTallArticleImage(1080, 2400)).toBe(true); // ~2.2 ratio
    expect(isTallArticleImage(1170, 2532)).toBe(true); // modern phone screenshot
  });

  it('treats stitched full-page captures as tall', () => {
    expect(isTallArticleImage(1080, 6000)).toBe(true);
    expect(isTallArticleImage(800, 12000)).toBe(true);
  });

  it('classifies code screenshots (landscape) as regular', () => {
    expect(isTallArticleImage(1920, 1080)).toBe(false);
    expect(isTallArticleImage(2680, 1600)).toBe(false);
  });

  it('fails closed on unloaded or invalid dimensions', () => {
    expect(isTallArticleImage(0, 0)).toBe(false);
    expect(isTallArticleImage(0, 1000)).toBe(false);
    expect(isTallArticleImage(1000, 0)).toBe(false);
    expect(isTallArticleImage(Number.NaN, 1000)).toBe(false);
    expect(isTallArticleImage(-100, 1000)).toBe(false);
  });

  it('classifies exactly at the documented threshold', () => {
    const width = 1000;
    const edgeHeight = Math.ceil(TALL_IMAGE_RATIO * width);
    expect(isTallArticleImage(width, edgeHeight)).toBe(true);
    expect(isTallArticleImage(width, edgeHeight - 1)).toBe(false);
  });
});
