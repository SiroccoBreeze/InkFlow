import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import Prism from 'prismjs';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-yaml';
import { DocVisibility, KnowledgeDoc, TableOfContentItem } from '../types';

// Whitelist pattern for safe inline base64 raster/webp images only (PNG, JPEG, WebP, GIF)
// Specifically excludes data:text/html, data:text/javascript, data:image/svg+xml, etc.
const SAFE_IMAGE_BASE64_REGEX = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i;

// Strict HTML sanitizer options to prevent Stored XSS while preserving rich typography and code styling
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'img', 'span', 'button', 'mark', 'kbd', 'del', 'sub', 'sup',
  ],
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    '*': ['class', 'id', 'title', 'data-*'],
    a: ['href', 'name', 'target', 'rel', 'data-wikilink', 'data-slug', 'class', 'title', 'role'],
    img: ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading', 'class'],
    code: ['class'],
    pre: ['class'],
    button: ['class', 'title', 'data-*'],
    th: ['align', 'class'],
    td: ['align', 'class'],
  },
  // Only http, https, and mailto for general links. data: is strictly forbidden for normal hrefs
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    img: ['http', 'https', 'data'],
  },
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => {
      if (attribs.href) {
        const href = attribs.href.trim().toLowerCase();
        // Disallow data:, javascript:, vbscript:, or other pseudo-protocols
        if (href.startsWith('data:') || href.startsWith('javascript:') || href.startsWith('vbscript:')) {
          delete attribs.href;
        }
      }
      return { tagName, attribs };
    },
    img: (tagName, attribs) => {
      if (attribs.src) {
        const src = attribs.src.trim();
        if (src.toLowerCase().startsWith('data:')) {
          // Strictly match raster/webp base64 images; disallow svg, html, or malformed data URIs
          if (!SAFE_IMAGE_BASE64_REGEX.test(src)) {
            delete attribs.src;
          }
        }
      }
      if (attribs.srcset) {
        const srcset = attribs.srcset.trim().toLowerCase();
        // Disallow data: or script execution in srcset
        if (srcset.includes('data:') || srcset.includes('javascript:')) {
          delete attribs.srcset;
        }
      }
      return { tagName, attribs };
    },
  },
  disallowedTagsMode: 'discard',
};

// Configure marked with standard GitHub Flavored Markdown options
marked.setOptions({
  gfm: true,
  breaks: true,
});


/**
 * Parses YAML frontmatter from raw markdown string.
 */
export function parseFrontmatter(rawContent: string): {
  frontmatter: Record<string, any>;
  body: string;
} {
  const trimmed = rawContent.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: rawContent };
  }

  const endMatch = trimmed.slice(3).indexOf('---');
  if (endMatch === -1) {
    return { frontmatter: {}, body: rawContent };
  }

  const frontmatterString = trimmed.slice(3, endMatch + 3).trim();
  const body = trimmed.slice(endMatch + 6).replace(/^\n+/, '');

  const frontmatter: Record<string, any> = {};
  const lines = frontmatterString.split('\n');

  let currentKey: string | null = null;
  let isCollectingList = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    // Check for multiline list item "- item"
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('-') && isCollectingList && currentKey) {
      const itemVal = trimmedLine.slice(1).trim().replace(/^['"]|['"]$/g, '');
      if (Array.isArray(frontmatter[currentKey])) {
        frontmatter[currentKey].push(itemVal);
      } else {
        frontmatter[currentKey] = [itemVal];
      }
      continue;
    }

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      isCollectingList = false;
      currentKey = null;
      continue;
    }

    const key = line.slice(0, colonIndex).trim();
    let value: any = line.slice(colonIndex + 1).trim();

    currentKey = key;
    isCollectingList = false;

    // Empty value after colon might precede a multiline list
    if (value === '') {
      frontmatter[key] = [];
      isCollectingList = true;
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s: string) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else if (value === 'true') {
      value = true;
    } else if (value === 'false') {
      value = false;
    }

    if (key) {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

/**
 * Serializes document metadata and markdown body into standard canonical markdown with YAML frontmatter.
 */
export function serializeToMarkdown(doc: KnowledgeDoc): string {
  const tagsStr = doc.tags && doc.tags.length > 0 
    ? `[${doc.tags.map(t => `"${t}"`).join(', ')}]`
    : '[]';

  const frontmatter = [
    '---',
    `title: "${doc.title.replace(/"/g, '\\"')}"`,
    `slug: "${doc.slug}"`,
    `category: "${doc.category}"`,
    `tags: ${tagsStr}`,
    `visibility: "${doc.visibility}"`,
    `author: "${doc.author || 'Owner'}"`,
    `createdAt: "${doc.createdAt}"`,
    `updatedAt: "${doc.updatedAt}"`,
    doc.unlistedKey ? `unlistedKey: "${doc.unlistedKey}"` : null,
    '---',
    '',
  ].filter(line => line !== null).join('\n');

  return frontmatter + doc.rawMarkdown.trimStart();
}

/**
 * Extracts title from markdown if not specified in frontmatter.
 */
export function extractTitle(rawMarkdown: string, fallback: string = '无标题笔记'): string {
  const { frontmatter, body } = parseFrontmatter(rawMarkdown);
  if (frontmatter.title && typeof frontmatter.title === 'string') {
    return frontmatter.title;
  }

  const h1Match = body.match(/^#\s+(.+)$/m);
  if (h1Match && h1Match[1]) {
    return h1Match[1].trim();
  }

  const firstLine = body.split('\n').find(line => line.trim().length > 0);
  if (firstLine) {
    const cleanLine = firstLine.replace(/^#+\s*/, '').trim();
    if (cleanLine.length > 0) {
      return cleanLine.length > 40 ? cleanLine.slice(0, 40) + '...' : cleanLine;
    }
  }

  return fallback;
}

/**
 * Generates URL-friendly slug.
 */
export function generateSlug(title: string): string {
  const pinyinOrAscii = title
    .toLowerCase()
    .trim()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);

  const randomSuffix = Math.random().toString(36).substring(2, 6);
  return (pinyinOrAscii || 'doc') + '-' + randomSuffix;
}

/**
 * Calculates word count and estimated reading time.
 */
export function calculateReadingStats(content: string): {
  wordCount: number;
  readingTimeMinutes: number;
} {
  const clean = content.replace(/```[\s\S]*?```/g, '');
  const chineseChars = (clean.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishWords = (clean.match(/[a-zA-Z0-9_-]+/g) || []).length;
  const wordCount = chineseChars + englishWords;
  const readingTimeMinutes = Math.max(1, Math.ceil(wordCount / 300));

  return {
    wordCount,
    readingTimeMinutes,
  };
}

/**
 * Extracts Table of Contents items (h2, h3) from markdown.
 */
export function extractTableOfContents(rawMarkdown: string): TableOfContentItem[] {
  const { body } = parseFrontmatter(rawMarkdown);
  const headingRegex = /^(#{2,3})\s+(.+)$/gm;
  const items: TableOfContentItem[] = [];
  let match;

  while ((match = headingRegex.exec(body)) !== null) {
    const hashes = match[1];
    const text = match[2].trim().replace(/[*_`]/g, '');
    const level = hashes.length;
    const id = text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '');

    items.push({
      id: id || `heading-${items.length}`,
      text,
      level,
    });
  }

  return items;
}

/**
 * Extracts all [[WikiLinks]] from a raw markdown string, ignoring code blocks.
 */
export function extractWikiLinks(content: string): string[] {
  // Ignore fenced code blocks and inline code
  const clean = content.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, '');
  const matches = clean.match(/\[\[([^\]\n]+)\]\]/g);
  if (!matches) return [];
  return matches.map(m => {
    const raw = m.slice(2, -2).trim();
    // Handle [[target|alias]]
    return raw.split('|')[0].trim();
  });
}

/**
 * Renders markdown to safe HTML, injecting IDs into h2/h3 for anchor linking,
 * resolving attachment references, and parsing [[WikiLinks]] for second-brain interlinking.
 */
export function renderMarkdown(rawMarkdown: string, attachmentMap?: Record<string, string>): string {
  const { body } = parseFrontmatter(rawMarkdown);

  const renderer = new marked.Renderer();

  renderer.heading = function ({ tokens, depth }: { tokens: any[]; depth: number }) {
    const text = this.parser.parseInline(tokens);
    const plainText = text.replace(/<[^>]*>/g, '').trim();
    const id = plainText
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '');

    return `<h${depth} id="${id}" class="scroll-mt-24 group relative">${text}<a href="#${id}" class="opacity-0 group-hover:opacity-100 transition-opacity ml-2 text-neutral-400 no-underline font-normal text-sm" aria-hidden="true">#</a></h${depth}>\n`;
  };

  renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
    const rawLang = (lang || '').trim().toLowerCase();
    const aliasMap: Record<string, string> = {
      ts: 'typescript',
      js: 'javascript',
      sh: 'bash',
      shell: 'bash',
      zsh: 'bash',
      yml: 'yaml',
      py: 'python',
      md: 'markdown',
      golang: 'go',
    };
    const targetLang = aliasMap[rawLang] || rawLang || 'typescript';
    let highlighted: string;

    if (Prism.languages[targetLang]) {
      try {
        highlighted = Prism.highlight(text, Prism.languages[targetLang], targetLang);
      } catch {
        highlighted = text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
      }
    } else {
      highlighted = text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
    }

    const displayLang = (lang || 'code').toUpperCase();
    return `<div class="code-block-container relative group my-6 rounded-xl overflow-hidden border border-neutral-200 dark:border-neutral-800 bg-neutral-50/90 dark:bg-[#0c0c12] shadow-xs">
      <div class="code-header flex items-center justify-between px-4 py-2 bg-neutral-100/90 dark:bg-[#14141e] border-b border-neutral-200 dark:border-neutral-800 text-neutral-500 dark:text-neutral-400 text-xs font-mono select-none">
        <div class="flex items-center gap-2">
          <span class="flex gap-1.5 opacity-75">
            <span class="w-2.5 h-2.5 rounded-full bg-rose-500/80"></span>
            <span class="w-2.5 h-2.5 rounded-full bg-amber-500/80"></span>
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-500/80"></span>
          </span>
          <span class="text-[11px] font-semibold text-neutral-700 dark:text-neutral-300 ml-1.5">${displayLang}</span>
        </div>
        <button class="code-copy-btn px-2.5 py-0.5 text-[11px] rounded bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-200 transition-colors cursor-pointer shadow-2xs">复制</button>
      </div>
      <pre class="!m-0 !p-4 !bg-transparent overflow-x-auto text-xs font-mono leading-relaxed text-neutral-900 dark:text-neutral-100"><code class="language-${targetLang}">${highlighted}</code></pre>
    </div>\n`;
  };

  let processedBody = body;

  // 1. Process attachments: ![alt](attachment:id) -> dataUrl
  if (attachmentMap) {
    processedBody = processedBody.replace(/attachment:([a-zA-Z0-9_-]+)/g, (match, id) => {
      return attachmentMap[id] || match;
    });
  }

  // 2. Protect code blocks from wikilink parsing so code like [[1, 2]] is preserved
  const codeBlockPlaceholders: string[] = [];
  processedBody = processedBody.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (match) => {
    const placeholder = `__INKFLOW_CODE_BLOCK_${codeBlockPlaceholders.length}__`;
    codeBlockPlaceholders.push(match);
    return placeholder;
  });

  // 3. Process [[WikiLinks]] for Obsidian-style bidirectional knowledge connections
  // Supports [[Slug]], [[Slug|Alias]], [[Title]], [[Title|Alias]]
  processedBody = processedBody.replace(/\[\[([^\]\n]+)\]\]/g, (match, target) => {
    const parts = target.split('|');
    const linkTarget = parts[0].trim();
    const displayText = (parts[1] !== undefined ? parts[1].trim() : parts[0].trim()) || linkTarget;
    return `<a href="#" role="button" data-wikilink="${encodeURIComponent(linkTarget)}" data-slug="${encodeURIComponent(linkTarget)}" class="wikilink-btn inline-flex items-center gap-1 font-semibold text-neutral-900 dark:text-neutral-100 underline decoration-neutral-400 hover:decoration-neutral-900 dark:hover:decoration-white transition-colors cursor-pointer bg-neutral-100/80 dark:bg-neutral-800/80 px-1.5 py-0.5 rounded text-[0.9em] no-underline" title="双链文档: ${linkTarget}"><span>🔗</span><span>${displayText}</span></a>`;
  });

  // Restore masked code blocks
  processedBody = processedBody.replace(/__INKFLOW_CODE_BLOCK_(\d+)__/g, (_, idx) => {
    return codeBlockPlaceholders[Number(idx)] ?? _;
  });

  try {
    const rawHtml = marked.parse(processedBody, { renderer }) as string;
    return sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
  } catch (err) {
    console.error('Markdown parse error:', err);
    return `<p class="text-red-500">Markdown 渲染出错: ${(err as Error).message}</p><pre>${sanitizeHtml(processedBody, SANITIZE_OPTIONS)}</pre>`;
  }
}

