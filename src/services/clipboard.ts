/**
 * Clipboard helper shared by every copy affordance (code blocks, share links,
 * raw Markdown, citations).
 *
 * `navigator.clipboard` only exists in secure contexts (HTTPS or localhost) and
 * can still reject a write because of permission policy. InkFlow is often opened
 * over a plain-http LAN address (e.g. http://192.168.1.10:3000), where the API is
 * missing entirely and calling it would throw before any UI feedback is shown.
 * The hidden-textarea fallback keeps copying functional there.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof window !== 'undefined' && window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or document not focused: try the legacy path.
    }
  }
  return copyWithExecCommand(text);
}

function copyWithExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;

  let textarea: HTMLTextAreaElement | null = null;
  const selection = document.getSelection();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  try {
    textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    // Keep it out of view without hiding it from layout (execCommand ignores
    // `display: none` / `visibility: hidden` elements).
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea?.remove();
    if (selection && previousRange) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
  }
}
