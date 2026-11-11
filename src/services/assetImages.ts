/**
 * Authenticated asset image loading.
 *
 * Local assets are served from `/api/v1/assets/file/:id`, and that endpoint
 * requires an owner Bearer token for anything that is not a published public
 * document. A plain `<img src>` request never carries the Authorization header,
 * so images from private/draft documents used to render as broken icons in the
 * editor preview and in the reader.
 *
 * This helper fetches such images with the session token and swaps the element
 * over to an object URL, without ever putting the token into a URL.
 */

const LOCAL_ASSET_PATH_REGEX = /^\/api\/v1\/assets\/file\/[A-Za-z0-9_-]+\/?$/;

const blobUrlCache = new Map<string, Promise<string | null>>();
// Mirrors blobUrlCache for already-resolved entries, so a re-rendered <img> can be
// pointed at its object URL synchronously instead of flashing an empty frame.
const resolvedUrls = new Map<string, string>();

function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return (
      localStorage.getItem('inkflow_auth_token') ||
      (JSON.parse(localStorage.getItem('inkflow_session_v1') || '{}') as any)?.token ||
      null
    );
  } catch {
    return null;
  }
}

/** True for same-origin local asset URLs produced by the upload API. */
export function isLocalAssetUrl(src: string): boolean {
  if (typeof src !== 'string' || !src) return false;
  if (LOCAL_ASSET_PATH_REGEX.test(src)) return true;
  if (typeof window !== 'undefined') {
    try {
      const url = new URL(src, window.location.origin);
      return url.origin === window.location.origin && LOCAL_ASSET_PATH_REGEX.test(url.pathname);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Resolves a local asset URL to an object URL fetched with credentials.
 * Results are cached so re-renders (every keystroke in the editor) do not
 * re-download the same image. Returns null when the asset cannot be read.
 */
export function loadAuthedAssetUrl(src: string): Promise<string | null> {
  const resolved = resolvedUrls.get(src);
  if (resolved) return Promise.resolve(resolved);

  const cached = blobUrlCache.get(src);
  if (cached) return cached;

  const pending = (async () => {
    try {
      const token = getAuthToken();
      const res = await fetch(src, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      resolvedUrls.set(src, objectUrl);
      return objectUrl;
    } catch {
      return null;
    }
  })();

  blobUrlCache.set(src, pending);
  return pending;
}

/**
 * Walks a rendered Markdown container and replaces local asset `<img>` sources
 * with authenticated object URLs. Safe to call after every render; already
 * hydrated images are skipped and stale async replacements are ignored.
 *
 * Returns a cleanup function that stops pending replacements.
 */
export function hydrateAuthedImages(root: HTMLElement | null): () => void {
  if (!root) return () => {};

  let cancelled = false;

  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'));
  for (const img of images) {
    const originalSrc = img.getAttribute('src') || '';
    if (!isLocalAssetUrl(originalSrc)) continue;
    if (img.dataset.inkflowOrigSrc === originalSrc) continue;

    img.dataset.inkflowOrigSrc = originalSrc;
    const ready = resolvedUrls.get(originalSrc);
    if (ready) {
      // Already fetched earlier this session: swap before the broken-image icon shows.
      img.setAttribute('src', ready);
      delete img.dataset.inkflowPending;
      continue;
    }

    img.dataset.inkflowPending = '1';
    loadAuthedAssetUrl(originalSrc).then(objectUrl => {
      if (cancelled) return;
      // The element may have been re-rendered or the document may have changed.
      if (!img.isConnected || img.getAttribute('src') !== originalSrc) return;
      delete img.dataset.inkflowPending;
      if (!objectUrl) return;
      img.setAttribute('src', objectUrl);
      // Keep a readable caption for the reader lightbox
      if (!img.alt) img.alt = '附件图片';
    });
  }

  return () => {
    cancelled = true;
  };
}
