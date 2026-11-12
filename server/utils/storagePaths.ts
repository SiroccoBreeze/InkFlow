import path from 'node:path';

/**
 * Storage path helpers shared by the filesystem service, the schema migration and
 * (later) the backup/restore package format.
 *
 * The database stores paths relative to the storage root. Historically these were
 * produced with `path.relative()`, so a Windows installation wrote backslashes
 * (`documents\\doc_x\\index.md`). A backup taken on Windows must be restorable on
 * Linux, so the canonical on-disk/DB representation is now POSIX (`/`) regardless
 * of the host platform. Reads still accept legacy backslash paths.
 */

/**
 * Normalizes a storage-relative path to POSIX form.
 *
 * Returns null for anything that is not a plain, contained relative path:
 * absolute paths, drive letters, UNC paths, NUL bytes, empty segments, `.`/`..`.
 */
export function normalizeStorageRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  let normalized = value.trim();
  if (!normalized || normalized.includes('\0')) return null;

  // Windows separators → POSIX, then repeatedly strip leading ./
  normalized = normalized.replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);

  if (!normalized) return null;
  // Absolute POSIX path, Windows drive path, or UNC path.
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;

  const segments = normalized.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null;
  }

  return segments.join('/');
}

/** True when the value is a safe storage-relative path (in any platform spelling). */
export function isSafeStorageRelativePath(value: unknown): boolean {
  return normalizeStorageRelativePath(value) !== null;
}

/**
 * Resolves a storage-relative path inside `root` and guarantees containment.
 * The containment check is repeated after resolution (defense in depth against
 * encoded traversal), and the result always uses the host platform's separators.
 */
export function resolveInsideRoot(root: string, relativePath: unknown): string | null {
  const normalized = normalizeStorageRelativePath(relativePath);
  if (!normalized) return null;

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return resolved;
}

/** Converts an absolute path inside `root` into the canonical POSIX relative form. */
export function toStorageRelativePath(root: string, absolutePath: string): string | null {
  return normalizeStorageRelativePath(path.relative(path.resolve(root), path.resolve(absolutePath)));
}
