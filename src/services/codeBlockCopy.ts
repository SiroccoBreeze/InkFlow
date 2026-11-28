import { copyTextToClipboard } from './clipboard';

const DEFAULT_LABEL = '复制';
const COPIED_LABEL = '已复制!';
const FAILED_LABEL = '复制失败';
const RESET_DELAY_MS = 2000;
const COPIED_CLASS = 'is-copied';
const FAILED_CLASS = 'is-copy-failed';

function resetLabel(btn: HTMLButtonElement, label: string): void {
  if (!btn.isConnected) return;
  btn.textContent = label;
  btn.classList.remove(COPIED_CLASS, FAILED_CLASS);
}

/**
 * Delegates clicks on the `复制` buttons that `renderMarkdown` injects into
 * every code block.
 *
 * Bind this to the container holding the `dangerouslySetInnerHTML` output. The
 * rendered HTML is replaced whenever the Markdown changes (the editor preview
 * re-renders on every keystroke), which would silently drop listeners attached
 * to individual buttons; a container listener survives those re-renders and also
 * covers buttons in pages other than the article reader.
 */
export function attachCodeBlockCopy(root: HTMLElement | null): () => void {
  if (!root) return () => {};

  const resetTimers = new WeakMap<HTMLButtonElement, number>();

  const handleClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const btn = target?.closest<HTMLButtonElement>('.code-copy-btn');
    if (!btn || !root.contains(btn)) return;

    const container = btn.closest('.code-block-container') || btn.closest('pre');
    const codeEl = container?.querySelector('code') || container?.querySelector('pre');
    if (!codeEl) return;

    event.preventDefault();
    event.stopPropagation();

    const originalLabel = btn.textContent?.trim() || DEFAULT_LABEL;

    void copyTextToClipboard(codeEl.textContent || '').then(ok => {
      // The preview may have been re-rendered while the clipboard write was pending.
      if (!btn.isConnected) return;

      btn.textContent = ok ? COPIED_LABEL : FAILED_LABEL;
      btn.classList.toggle(COPIED_CLASS, ok);
      btn.classList.toggle(FAILED_CLASS, !ok);

      const previousTimer = resetTimers.get(btn);
      if (previousTimer !== undefined) window.clearTimeout(previousTimer);
      resetTimers.set(
        btn,
        window.setTimeout(() => resetLabel(btn, originalLabel), RESET_DELAY_MS)
      );
    });
  };

  root.addEventListener('click', handleClick);
  return () => root.removeEventListener('click', handleClick);
}
