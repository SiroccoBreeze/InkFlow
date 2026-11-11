import JSZip from 'jszip';
import {
  Attachment,
  Category,
  CommentItem,
  DocVersion,
  ForumReply,
  ForumTopic,
  GraphLink,
  GraphNode,
  KnowledgeDoc,
  UserRole,
  UserSession,
  WikiBacklink,
} from '../types';
import { DEFAULT_CATEGORIES, INITIAL_DOCS, INITIAL_VERSIONS } from './defaultData';
import {
  calculateReadingStats,
  extractTitle,
  extractWikiLinks,
  generateSlug,
  parseFrontmatter,
  serializeToMarkdown,
} from './markdown';
import { apiClient } from './apiClient';

const STORAGE_KEYS = {
  DOCS: 'inkflow_docs_v1',
  CATEGORIES: 'inkflow_categories_v1',
  VERSIONS: 'inkflow_versions_v1',
  ATTACHMENTS: 'inkflow_attachments_v1',
  SESSION: 'inkflow_session_v1',
  SETTINGS: 'inkflow_settings_v1',
  COMMENTS: 'inkflow_comments_v1',
  FORUM_TOPICS: 'inkflow_forum_topics_v1',
  FORUM_REPLIES: 'inkflow_forum_replies_v1',
};


const INITIAL_COMMENTS: CommentItem[] = [
  {
    id: 'comm-1',
    docId: 'doc-local-first',
    authorName: 'Alex Lin (分布式研究员)',
    authorRole: 'contributor',
    content: '非常赞同对数据主权的强调！尤其在弱网或网络中断场景下，Local-First 与 CRDT 结合确实比单纯的云端缓存稳健得多。',
    createdAt: '2026-10-28T14:30:00Z',
    upvotes: 14,
  },
  {
    id: 'comm-2',
    docId: 'doc-local-first',
    authorName: 'Hecker (Owner)',
    authorRole: 'owner',
    content: '感谢 Alex！下一步在 Stage 2 中我们会在 InkFlow 引入端到端加密的 Relay 中继实验，欢迎在论坛 RFC 中深入探讨！',
    createdAt: '2026-10-28T16:00:00Z',
    upvotes: 9,
    isPinned: true,
  },
  {
    id: 'comm-3',
    docId: 'doc-second-brain',
    authorName: 'Chen (独立开发者)',
    authorRole: 'reader',
    content: '卡片盒笔记中最核心的难点就是形成结构笔记（MOC），支持 [[WikiLinks]] 与反向链接后，思考的网状连接自然浮现了！',
    createdAt: '2026-10-29T09:12:00Z',
    upvotes: 6,
  },
];

const INITIAL_FORUM_TOPICS: ForumTopic[] = [
  {
    id: 'topic-1',
    title: '【RFC-01】多用户协作下 Markdown 冲突解决协议设计提案',
    category: 'rfc',
    authorName: 'Hecker (Owner)',
    authorRole: 'owner',
    createdAt: '2026-10-25T10:00:00Z',
    replyCount: 3,
    upvotes: 21,
    pinned: true,
    tags: ['RFC', 'LocalFirst', 'CRDT'],
    content: `### 提案背景

随着知识库从单机向团队协作演进，如何在坚持“Markdown 文本为单一事实来源”的前提下，解决多人同时编辑同一章节的并发冲突？

### 核心论点
1. 基于纯文本 AST 的行级 3-Way Merge。
2. 引入逻辑时钟向量（Lamport Timestamp）标定修订顺序。
3. 冲突时在 Markdown 内自动插入 Git 风格的分歧标记段落，让用户保有最终裁决权。

欢迎各位读者与共创者在此展开技术研讨！`,
  },
  {
    id: 'topic-2',
    title: '【已解答】关于附件在本地优先架构下的存储容量与持久化策略',
    category: 'qa',
    authorName: 'Kobe (Contributor)',
    authorRole: 'contributor',
    createdAt: '2026-10-27T15:20:00Z',
    replyCount: 2,
    upvotes: 11,
    isResolved: true,
    tags: ['IndexedDB', '附件存储'],
    content: `当知识库中插入了大量高精度的架构草图与 PDF 文档时，浏览器 IndexedDB 是否有上限？

**解答**：现代浏览器对单个 Origin 的存储配额通常为可用硬盘空间的 20%~60%（通常数十 GB），完全满足个人与团队知识沉淀。同时 InkFlow 导出 ZIP 支持将附件独立归档。`,
  },
  {
    id: 'topic-3',
    title: '卡片盒笔记实操：如何平衡“闪念记录”与“永久文献归档”的转化阻力？',
    category: 'discussion',
    authorName: 'Sophia (Reader)',
    authorRole: 'reader',
    createdAt: '2026-10-30T11:45:00Z',
    replyCount: 4,
    upvotes: 16,
    tags: ['Zettelkasten', '第二大脑', '学习方法'],
    content: `在日常实践卡片盒笔记法时，发现最容易积压的是“闪念笔记”。大家通常多久清理一次收件箱？是否会直接在编辑时就添加双向链接？`,
  },
  {
    id: 'topic-4',
    title: 'InkFlow 演进公告：双向链接 WikiLinks、双脑图谱与共创广场正式上线',
    category: 'changelog',
    authorName: 'Hecker (Owner)',
    authorRole: 'owner',
    createdAt: '2026-11-01T08:30:00Z',
    replyCount: 1,
    upvotes: 35,
    pinned: true,
    tags: ['系统公告', '演进里程碑'],
    content: `欢迎来到全新的 InkFlow 知识门户！本次升级带来：
- 🌟 **Obsidian 风格双向链接**：支持 \`[[标题]]\` 自动互联。
- 🕸️ **交互式双脑知识图谱**：全景可视化知识拓扑脉络。
- 💬 **文献研讨与评论批注**：每篇文章均可畅谈心得。
- 🏛️ **多用户共创广场 (Forum)**：深度问答与 RFC 提案。`,
  },
];

const INITIAL_FORUM_REPLIES: ForumReply[] = [
  {
    id: 'reply-1',
    topicId: 'topic-1',
    authorName: 'Alex Lin (分布式研究员)',
    authorRole: 'contributor',
    content: '赞同采用 AST 节点级 Merge，相比字符级 Diff 能够更好保留代码块与表格的语法完整性！',
    createdAt: '2026-10-25T14:10:00Z',
    upvotes: 8,
  },
  {
    id: 'reply-2',
    topicId: 'topic-1',
    authorName: 'Hecker (Owner)',
    authorRole: 'owner',
    content: '正是如此，后续我们会发布针对 Markdown AST 节点分块的试验性原型。',
    createdAt: '2026-10-25T16:00:00Z',
    upvotes: 5,
  },
  {
    id: 'reply-3',
    topicId: 'topic-3',
    authorName: 'Chen (独立开发者)',
    authorRole: 'reader',
    content: '我的经验是：设定“每周五下午”为永久笔记提炼时间，每周只精选 3 张卡片汇入图谱，质量远重于数量！',
    createdAt: '2026-10-30T14:00:00Z',
    upvotes: 7,
  },
];

export interface SaveDocError {
  code: string;
  message: string;
  status?: number;
  retryable: boolean;
  details?: any;
}

export interface BulkSaveResult {
  total: number;
  succeeded: number;
  failed: number;
  errors: SaveDocError[];
  /** Document saves succeeded but the server tag dictionary cleanup request failed. */
  dictionaryCleanupFailed?: boolean;
  /** Server still found document references (or the Markdown scan failed), so the tag dictionary was kept. */
  dictionaryRetained?: boolean;
}

export interface SaveDocResult {
  success: boolean;
  serverSaved: boolean;
  /** Candidate doc built from the input; on success, the server-adopted document. */
  doc: KnowledgeDoc;
  error?: SaveDocError;
}

export class StorageService {
  private docsCache: KnowledgeDoc[] | null = null;
  private categoriesCache: Category[] | null = null;
  private versionsCache: DocVersion[] | null = null;
  private attachmentsCache: Attachment[] | null = null;
  private commentsCache: CommentItem[] | null = null;
  private topicsCache: ForumTopic[] | null = null;
  private repliesCache: ForumReply[] | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    if (typeof window === 'undefined') return;

    if (!localStorage.getItem(STORAGE_KEYS.DOCS)) {
      // Add wikilinks into initial docs so they interconnect beautifully!
      const enrichedDocs = INITIAL_DOCS.map(doc => {
        if (doc.id === 'doc-local-first') {
          return {
            ...doc,
            rawMarkdown: doc.rawMarkdown + '\n\n## 相关关联笔记\n\n- 参见方法论探索：[[打造个人第二大脑：卡片盒笔记法与知识图谱]]\n- 参见工程代码实践：[[现代 TypeScript 类型体操与工程化避坑手册]]\n',
          };
        }
        if (doc.id === 'doc-second-brain') {
          return {
            ...doc,
            rawMarkdown: doc.rawMarkdown + '\n\n## 延伸思考\n\n- 参见底层数据模型：[[本地优先（Local-First）软件架构的思考与实践]]\n',
          };
        }
        return doc;
      });
      localStorage.setItem(STORAGE_KEYS.DOCS, JSON.stringify(enrichedDocs));
    }
    if (!localStorage.getItem(STORAGE_KEYS.CATEGORIES)) {
      localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(DEFAULT_CATEGORIES));
    }
    if (!localStorage.getItem(STORAGE_KEYS.VERSIONS)) {
      localStorage.setItem(STORAGE_KEYS.VERSIONS, JSON.stringify(INITIAL_VERSIONS));
    }
    if (!localStorage.getItem(STORAGE_KEYS.ATTACHMENTS)) {
      localStorage.setItem(STORAGE_KEYS.ATTACHMENTS, JSON.stringify([]));
    }
    if (!localStorage.getItem(STORAGE_KEYS.COMMENTS)) {

      localStorage.setItem(STORAGE_KEYS.COMMENTS, JSON.stringify(INITIAL_COMMENTS));
    }
    if (!localStorage.getItem(STORAGE_KEYS.FORUM_TOPICS)) {
      localStorage.setItem(STORAGE_KEYS.FORUM_TOPICS, JSON.stringify(INITIAL_FORUM_TOPICS));
    }
    if (!localStorage.getItem(STORAGE_KEYS.FORUM_REPLIES)) {
      localStorage.setItem(STORAGE_KEYS.FORUM_REPLIES, JSON.stringify(INITIAL_FORUM_REPLIES));
    }
  }

  // --- Document Operations ---

  public getDocs(): KnowledgeDoc[] {
    if (this.docsCache) return this.docsCache;
    try {
      const data = localStorage.getItem(STORAGE_KEYS.DOCS);
      this.docsCache = data ? JSON.parse(data) : INITIAL_DOCS;
      return this.docsCache || [];
    } catch (e) {
      console.error('Failed to load docs from local storage', e);
      return INITIAL_DOCS;
    }
  }

  public getDocById(id: string): KnowledgeDoc | undefined {
    return this.getDocs().find(d => d.id === id);
  }

  /** Unlisted links are only handed out for genuinely published documents. */
  public getDocByUnlistedKey(key: string): KnowledgeDoc | undefined {
    return this.getDocs().find(
      d => d.visibility === 'unlisted' && d.unlistedKey === key && (d.status ?? 'published') === 'published'
    );
  }

  public getDocBySlug(slug: string): KnowledgeDoc | undefined {
    return this.getDocs().find(d => d.slug === slug);
  }

  public getDocByTitleOrSlug(target: string): KnowledgeDoc | undefined {
    const cleanTarget = target.trim().toLowerCase();
    return this.getDocs().find(
      d =>
        d.slug.trim().toLowerCase() === cleanTarget ||
        d.title.trim().toLowerCase() === cleanTarget ||
        d.id.trim().toLowerCase() === cleanTarget
    );
  }

  // Serialises saves per document: each queued save starts only after the previous
  // one settled, so two clicks cannot race each other with the same version number.
  private saveQueues = new Map<string, Promise<SaveDocResult>>();
  private inFlightSaves = new Map<string, { signature: string; promise: Promise<SaveDocResult> }>();

  /**
   * Persists a document.
   *
   * Local cache is updated ONLY after the server confirms the write, so a failed
   * save never masquerades as success. The returned `doc` is the candidate built
   * from the editor input and is useful for error reporting; on success it is the
   * server-adopted document (including the new versionCount/updatedAt).
   */
  public saveDoc(
    docInput: Partial<KnowledgeDoc> & { rawMarkdown: string },
    note?: string
  ): Promise<SaveDocResult> {
    const docId =
      docInput.id || `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const input = { ...docInput, id: docId };

    const signature = JSON.stringify({
      id: docId,
      title: input.title,
      rawMarkdown: input.rawMarkdown,
      category: input.category,
      tags: input.tags,
      visibility: input.visibility,
      status: input.status,
      pinned: input.pinned,
      author: input.author,
      note: note || '',
    });

    // Identical request already in flight → share its promise instead of sending twice.
    const inFlight = this.inFlightSaves.get(docId);
    if (inFlight && inFlight.signature === signature) {
      return inFlight.promise;
    }

    const previous = this.saveQueues.get(docId);
    const promise = (previous ? previous.catch(() => null) : Promise.resolve(null))
      .then(() => this.performSave(input as Partial<KnowledgeDoc> & { rawMarkdown: string }, note))
      .catch(err => ({
        success: false,
        serverSaved: false,
        doc: (this.getDocById(docId) || (input as unknown as KnowledgeDoc)),
        error: {
          code: 'CLIENT_ERROR',
          message: `保存时发生未知错误：${err?.message || '请重试'}`,
          retryable: true,
        },
      }));

    this.saveQueues.set(docId, promise);
    this.inFlightSaves.set(docId, { signature, promise });

    const cleanup = () => {
      if (this.saveQueues.get(docId) === promise) this.saveQueues.delete(docId);
      const current = this.inFlightSaves.get(docId);
      if (current?.promise === promise) this.inFlightSaves.delete(docId);
    };
    void promise.then(cleanup, cleanup);

    return promise;
  }

  private async performSave(
    docInput: Partial<KnowledgeDoc> & { rawMarkdown: string },
    note?: string
  ): Promise<SaveDocResult> {
    const docs = this.getDocs();
    const now = new Date().toISOString();
    const stats = calculateReadingStats(docInput.rawMarkdown);
    const existingIndex = docs.findIndex(d => d.id === docInput.id);
    const existing = existingIndex >= 0 ? docs[existingIndex] : undefined;
    const contentChanged = existing ? existing.rawMarkdown !== docInput.rawMarkdown : true;

    let candidate: KnowledgeDoc;

    if (existing) {
      candidate = {
        ...existing,
        ...docInput,
        title: docInput.title || existing.title || extractTitle(docInput.rawMarkdown),
        slug: docInput.slug || existing.slug || generateSlug(docInput.title || 'doc'),
        category: docInput.category || existing.category || '未分类',
        tags: docInput.tags || existing.tags || [],
        visibility: docInput.visibility || existing.visibility || 'private',
        status: docInput.status || existing.status || 'draft',
        unlistedKey:
          docInput.visibility === 'unlisted'
            ? existing.unlistedKey || Math.random().toString(36).slice(2, 10)
            : undefined,
        updatedAt: now,
        wordCount: stats.wordCount,
        readingTimeMinutes: stats.readingTimeMinutes,
        // The server owns the version counter; adopt it in the success branch.
        versionCount: existing.versionCount,
      };
    } else {
      const title = docInput.title || extractTitle(docInput.rawMarkdown);
      candidate = {
        id: docInput.id as string,
        slug: docInput.slug || generateSlug(title),
        title,
        rawMarkdown: docInput.rawMarkdown,
        category: docInput.category || '架构与系统',
        tags: docInput.tags || [],
        visibility: docInput.visibility || 'private',
        status: docInput.status || 'draft',
        unlistedKey:
          docInput.visibility === 'unlisted' ? Math.random().toString(36).slice(2, 10) : undefined,
        author: docInput.author || 'Owner',
        createdAt: now,
        updatedAt: now,
        versionCount: 0,
        wordCount: stats.wordCount,
        readingTimeMinutes: stats.readingTimeMinutes,
        pinned: docInput.pinned || false,
        attachments: docInput.attachments || [],
      };
    }

    const res = await apiClient.saveDocument(
      {
        id: candidate.id,
        title: candidate.title,
        slug: candidate.slug,
        rawMarkdown: candidate.rawMarkdown,
        category: candidate.category,
        tags: candidate.tags,
        visibility: candidate.visibility,
        status: candidate.status,
        pinned: candidate.pinned,
        author: candidate.author,
        expectedVersionCount: existing ? existing.versionCount : undefined,
      },
      note,
      { create: !existing }
    );

    if (res.error || !res.data) {
      return {
        success: false,
        serverSaved: false,
        doc: candidate,
        error: StorageService.toSaveError(res.error),
      };
    }

    const serverDoc = res.data;
    const adopted: KnowledgeDoc = {
      ...candidate,
      id: serverDoc.id || candidate.id,
      slug: serverDoc.slug || candidate.slug,
      title: serverDoc.title || candidate.title,
      category: serverDoc.category || candidate.category,
      tags: Array.isArray(serverDoc.tags) ? serverDoc.tags : candidate.tags,
      visibility: serverDoc.visibility || candidate.visibility,
      status: serverDoc.status || candidate.status,
      pinned: Boolean(serverDoc.pinned ?? candidate.pinned),
      author: serverDoc.author || candidate.author,
      rawMarkdown: serverDoc.rawMarkdown || candidate.rawMarkdown,
      createdAt: serverDoc.createdAt || candidate.createdAt,
      updatedAt: serverDoc.updatedAt || candidate.updatedAt,
      versionCount: Number(serverDoc.versionCount) || candidate.versionCount,
      wordCount: Number(serverDoc.wordCount) || candidate.wordCount,
      readingTimeMinutes: Number(serverDoc.readingTime) || candidate.readingTimeMinutes,
      unlistedKey: candidate.unlistedKey,
      attachments: candidate.attachments,
    };

    // Only now is the local cache allowed to reflect the change.
    const latest = this.getDocs();
    const index = latest.findIndex(d => d.id === adopted.id);
    if (index >= 0) latest[index] = adopted;
    else latest.unshift(adopted);
    this.persistDocs(latest);

    if (contentChanged) {
      this.createVersionSnapshot(adopted, note || (existing ? '更新文档内容' : '创建文档初始化版本'));
    }

    return { success: true, serverSaved: true, doc: adopted };
  }

  /** Pulls an authoritative server document into the local cache (e.g. after rollback). */
  public adoptServerDoc(doc: KnowledgeDoc): KnowledgeDoc {
    const docs = this.getDocs();
    const index = docs.findIndex(d => d.id === doc.id);
    const merged = index >= 0 ? { ...docs[index], ...doc } : doc;
    if (index >= 0) docs[index] = merged;
    else docs.unshift(merged);
    this.persistDocs(docs);
    return merged;
  }

  private static toSaveError(error?: {
    code?: string;
    message?: string;
    status?: number;
    details?: any;
  }): SaveDocError {
    const status = error?.status;
    const code = error?.code || 'SAVE_FAILED';

    if (status === 409 || code === 'VERSION_CONFLICT') {
      return {
        code: 'VERSION_CONFLICT',
        message: '文档已被其他客户端修改，你的编辑内容仍保留。请刷新页面载入最新版本后重试。',
        status,
        retryable: false,
        details: error?.details,
      };
    }
    if (status === 401 || status === 403 || code === 'UNAUTHORIZED') {
      return {
        code: 'AUTH_ERROR',
        message: '登录状态已失效或权限不足，请重新登录后重试。',
        status,
        retryable: false,
      };
    }
    if (status === 428) {
      return {
        code: 'VERSION_REQUIRED',
        message: '缺少文档版本号，请刷新页面后重试保存。',
        status,
        retryable: false,
      };
    }
    if (code === 'DELETE_RECOVERY_REQUIRED') {
      return {
        code: 'DELETE_RECOVERY_REQUIRED',
        message:
          '保存已暂停：该文档存在未完成的删除清理任务，为避免数据复活，需要管理员处理后再保存。你的编辑内容仍保留。',
        status,
        retryable: false,
        details: error?.details,
      };
    }
    if (code === 'SAVE_RECOVERY_REQUIRED' || status === 503) {
      return {
        code: 'RECOVERY_REQUIRED',
        message:
          '保存已暂停：该文档存在未完成的恢复任务，为避免覆盖备份，需要管理员处理后再保存。你的编辑内容仍保留。',
        status,
        retryable: false,
        details: error?.details,
      };
    }
    if (code === 'NETWORK_ERROR' || status === 0) {
      return {
        code: 'NETWORK_ERROR',
        message: '网络连接失败，内容仍保留在编辑器中，请检查网络后重试。',
        status: 0,
        retryable: true,
      };
    }
    if (!status || status >= 500) {
      return {
        code: 'SERVER_ERROR',
        message: error?.message
          ? `服务器保存失败：${error.message}。内容仍保留在编辑器中，请稍后重试。`
          : '服务器保存失败，内容仍保留在编辑器中，请稍后重试。',
        status,
        retryable: true,
      };
    }
    return {
      code,
      message: error?.message || '保存失败，内容仍保留在编辑器中。',
      status,
      retryable: false,
    };
  }

  public async deleteDoc(id: string): Promise<{ success: true; diskCleanupPending: boolean }> {
    // 1. Direct explicit server physical disk & SQLite deletion
    let diskCleanupPending = false;
    try {
      const res = await apiClient.deleteDocument(id);
      if (res.error) {
        throw new Error(`磁盘 I/O 异常: ${res.error.message || '无法删除物理文件'}`);
      }
      diskCleanupPending = Boolean(res.data?.diskCleanupPending);
    } catch (err: any) {
      console.error('[InkFlow Storage] Server disk delete error:', err);
      throw new Error(`服务器磁盘文件删除失败: ${err.message || 'I/O 异常'}`);
    }

    // 2. Remove from local caches
    const docs = this.getDocs().filter(d => d.id !== id);
    this.persistDocs(docs);
    const versions = this.getVersions().filter(v => v.docId !== id);
    this.persistVersions(versions);
    return { success: true, diskCleanupPending };
  }

  public async batchDeleteDocs(
    ids: string[]
  ): Promise<{ success: true; diskCleanupPending: number }> {
    const errors: string[] = [];
    let diskCleanupPending = 0;
    for (const id of ids) {
      try {
        const res = await apiClient.deleteDocument(id);
        if (res.error) {
          errors.push(res.error.message || `文档 ${id} 删除失败`);
        } else if (res.data?.diskCleanupPending) {
          diskCleanupPending++;
        }
      } catch (err: any) {
        errors.push(err.message || `文档 ${id} 物理删除异常`);
      }
    }

    const idSet = new Set(ids);
    const docs = this.getDocs().filter(d => !idSet.has(d.id));
    this.persistDocs(docs);
    const versions = this.getVersions().filter(v => !idSet.has(v.docId));
    this.persistVersions(versions);

    if (errors.length > 0) {
      throw new Error(`部分文档磁盘删除异常: ${errors.join('; ')}`);
    }
    return { success: true, diskCleanupPending };
  }

  private persistDocs(docs: KnowledgeDoc[]): void {
    this.docsCache = docs;
    localStorage.setItem(STORAGE_KEYS.DOCS, JSON.stringify(docs));
  }

  // --- Backend Physical Markdown & SQLite Dual Sync ---
  public async syncFromBackend(): Promise<boolean> {
    try {
      const isOwner = this.getSession().isOwner;
      const res = await apiClient.getDocuments({
        visibility: isOwner ? 'all' : 'public',
      });

      if (res.data && Array.isArray(res.data)) {
        // True physical sync from backend: backend disk is SSOT!
        const backendDocs: KnowledgeDoc[] = res.data.map((backendDoc: any) => ({
          id: backendDoc.id,
          slug: backendDoc.slug,
          title: backendDoc.title,
          rawMarkdown: backendDoc.rawMarkdown || `# ${backendDoc.title}\n\n`,
          category: backendDoc.category || '未分类',
          tags: backendDoc.tags || [],
          // Fail closed: an unexpected visibility/status from the server must never render as public content
          visibility: (['public', 'private', 'unlisted'].includes(backendDoc.visibility)
            ? backendDoc.visibility
            : 'private'),
          status: (['draft', 'published', 'archived'].includes(backendDoc.status)
            ? backendDoc.status
            : 'draft'),
          pinned: Boolean(backendDoc.pinned),
          author: backendDoc.author || 'Hecker',
          createdAt: backendDoc.createdAt || backendDoc.created_at || new Date().toISOString(),
          updatedAt: backendDoc.updatedAt || backendDoc.updated_at || new Date().toISOString(),
          versionCount: backendDoc.versionCount || backendDoc.version_count || 1,
          wordCount: backendDoc.wordCount || backendDoc.word_count || 0,
          readingTimeMinutes: backendDoc.readingTime || backendDoc.reading_time || 1,
          attachments: [],
          unlistedKey: backendDoc.unlistedKey,
        }));

        this.persistDocs(backendDocs);
      }

      // Sync categories from SQLite backend
      const catRes = await apiClient.getCategories();
      if (catRes.data && Array.isArray(catRes.data) && catRes.data.length > 0) {
        const mapped = catRes.data.map((c: any) => ({
          id: c.id,
          name: c.name,
          slug: c.slug || c.name.toLowerCase(),
          description: c.description || '',
          order: c.sort_order || 0,
        }));
        this.categoriesCache = mapped;
        localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(mapped));
      }

      return true;
    } catch {
      return false;
    }
  }

  // --- Backlinks Calculation ---

  public getBacklinks(targetDocId: string): WikiBacklink[] {
    const allDocs = this.getDocs();
    const targetDoc = allDocs.find(d => d.id === targetDocId);
    if (!targetDoc) return [];

    const backlinks: WikiBacklink[] = [];

    for (const source of allDocs) {
      if (source.id === targetDocId) continue;

      const links = extractWikiLinks(source.rawMarkdown);
      const targetTitle = targetDoc.title.toLowerCase();
      const targetSlug = targetDoc.slug.toLowerCase();

      const isLinked = links.some(link => {
        const l = link.toLowerCase();
        return l === targetTitle || l === targetSlug;
      });

      if (isLinked) {
        // Find excerpt around the link
        const regex = new RegExp(`\\[\\[.*?(?:${targetDoc.title}|${targetDoc.slug}).*?\\]\\]`, 'i');
        const match = source.rawMarkdown.match(regex);
        let excerpt = '';
        if (match && match.index !== undefined) {
          const start = Math.max(0, match.index - 50);
          const end = Math.min(source.rawMarkdown.length, match.index + match[0].length + 50);
          excerpt = '...' + source.rawMarkdown.substring(start, end).replace(/\n/g, ' ') + '...';
        }

        backlinks.push({
          sourceDocId: source.id,
          sourceDocTitle: source.title,
          sourceDocSlug: source.slug,
          sourceCategory: source.category,
          excerpt,
        });
      }
    }

    return backlinks;
  }

  // --- Knowledge Graph Data Generation ---

  public getGraphData(): { nodes: GraphNode[]; links: GraphLink[] } {
    const docs = this.getDocs().filter(
      d => d.visibility === 'public' && (d.status ?? 'published') === 'published'
    );
    const nodes: GraphNode[] = [];
    const links: GraphLink[] = [];
    const tagSet = new Set<string>();

    // 1. Doc Nodes
    docs.forEach(doc => {
      nodes.push({
        id: doc.id,
        label: doc.title,
        category: doc.category,
        type: 'doc',
        val: Math.max(8, Math.min(24, Math.floor(doc.wordCount / 100))),
      });

      (doc.tags || []).forEach(t => tagSet.add(t));
    });

    // 2. Tag Nodes
    tagSet.forEach(tag => {
      nodes.push({
        id: `tag-${tag}`,
        label: `#${tag}`,
        category: 'Tag',
        type: 'tag',
        val: 6,
      });
    });

    // 3. Links from Docs to Tags
    docs.forEach(doc => {
      (doc.tags || []).forEach(t => {
        links.push({
          source: doc.id,
          target: `tag-${t}`,
        });
      });
    });

    // 4. Links between Docs from [[WikiLinks]]
    docs.forEach(doc => {
      const wikiLinks = extractWikiLinks(doc.rawMarkdown);
      wikiLinks.forEach(target => {
        const targetDoc = this.getDocByTitleOrSlug(target);
        if (
          targetDoc &&
          targetDoc.id !== doc.id &&
          targetDoc.visibility === 'public' &&
          (targetDoc.status ?? 'published') === 'published'
        ) {
          links.push({
            source: doc.id,
            target: targetDoc.id,
          });
        }
      });
    });

    return { nodes, links };
  }

  // --- Category Operations ---

  public getCategories(): Category[] {
    if (this.categoriesCache) return this.categoriesCache;
    try {
      const data = localStorage.getItem(STORAGE_KEYS.CATEGORIES);
      this.categoriesCache = data ? JSON.parse(data) : DEFAULT_CATEGORIES;
      return this.categoriesCache || [];
    } catch {
      return DEFAULT_CATEGORIES;
    }
  }

  public saveCategory(category: Category): void {
    const list = this.getCategories();
    const idx = list.findIndex(c => c.id === category.id);
    if (idx >= 0) {
      list[idx] = category;
    } else {
      list.push(category);
    }
    this.categoriesCache = list;
    localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(list));
    apiClient.createCategory({
      name: category.name,
      description: category.description,
      slug: category.slug,
    }).catch(() => {});
  }

  public deleteCategory(idOrName: string): void {
    const list = this.getCategories().filter(c => c.id !== idOrName && c.name !== idOrName);
    this.categoriesCache = list;
    localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(list));
    apiClient.deleteCategory(idOrName).catch(() => {});
  }

  public renameCategory(id: string, newName: string, newDesc?: string): void {
    const list = this.getCategories();
    const cat = list.find(c => c.id === id);
    if (!cat) return;

    const oldName = cat.name;
    cat.name = newName.trim();
    if (newDesc !== undefined) cat.description = newDesc.trim();
    this.categoriesCache = list;
    localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(list));

    // Update all docs that use this category
    const docs = this.getDocs();
    let changed = false;
    docs.forEach(d => {
      if (d.category === oldName) {
        d.category = newName.trim();
        changed = true;
      }
    });
    if (changed) {
      this.persistDocs(docs);
    }
  }

  // --- Tag Maintenance Operations ---

  public getAllTags(): { name: string; count: number }[] {
    const docs = this.getDocs();
    const tagCountMap: Record<string, number> = {};

    // Also load any custom registered tags
    let customTags: string[] = [];
    try {
      const data = localStorage.getItem('inkflow_custom_tags_v1');
      if (data) customTags = JSON.parse(data);
    } catch {}

    customTags.forEach(t => {
      tagCountMap[t] = 0;
    });

    docs.forEach(d => {
      (d.tags || []).forEach(t => {
        tagCountMap[t] = (tagCountMap[t] || 0) + 1;
      });
    });

    return Object.entries(tagCountMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  public addTag(tagName: string): void {
    const cleanTag = tagName.trim().replace(/^#/, '');
    if (!cleanTag) return;
    try {
      const data = localStorage.getItem('inkflow_custom_tags_v1');
      const list: string[] = data ? JSON.parse(data) : [];
      if (!list.includes(cleanTag)) {
        list.push(cleanTag);
        localStorage.setItem('inkflow_custom_tags_v1', JSON.stringify(list));
      }
    } catch {}
  }

  /** Applies a tag mutation to every affected document through the confirmed save path. */
  private async applyTagUpdateToDocs(
    docs: KnowledgeDoc[],
    updateTags: (tags: string[]) => string[],
    note: string
  ): Promise<BulkSaveResult> {
    const errors: SaveDocError[] = [];
    let attempted = 0;
    let succeeded = 0;

    // Sequential: each document save waits for the server (and its version check)
    // before the next one starts, so partial failures are deterministic.
    for (const doc of docs) {
      const currentTags = doc.tags || [];
      const nextTags = updateTags([...currentTags]);
      const unchanged =
        nextTags.length === currentTags.length && nextTags.every((tag, index) => tag === currentTags[index]);
      if (unchanged) continue;

      attempted++;
      const result = await this.saveDoc({ ...doc, tags: nextTags }, note);
      if (result.success) succeeded++;
      else {
        errors.push(
          result.error || {
            code: 'SAVE_FAILED',
            message: '保存失败',
            retryable: true,
          }
        );
      }
    }

    return { total: attempted, succeeded, failed: errors.length, errors };
  }

  private applyTagCleanupResult(
    result: BulkSaveResult,
    cleanup: Awaited<ReturnType<typeof apiClient.deleteTag>>
  ): void {
    if (cleanup.error) {
      result.dictionaryCleanupFailed = true;
      return;
    }
    if (cleanup.data?.reason) {
      // The server could not verify Markdown references; treat the dictionary as
      // not cleaned so the local dictionary is not silently diverged.
      result.dictionaryCleanupFailed = true;
      return;
    }
    if (cleanup.data && cleanup.data.tagDeleted === false && (cleanup.data.referencedDocuments || 0) > 0) {
      result.dictionaryRetained = true;
    }
  }

  private updateCustomTags(updater: (list: string[]) => string[]): void {
    try {
      const data = localStorage.getItem('inkflow_custom_tags_v1');
      if (!data) return;
      const list: string[] = JSON.parse(data);
      localStorage.setItem('inkflow_custom_tags_v1', JSON.stringify(updater(list)));
    } catch {
      // custom tag dictionary is a local convenience cache
    }
  }

  /**
   * Rename a tag across all documents. Each document goes through saveDoc(), so
   * the local cache is only updated after the server confirms it. Returns null
   * when the rename is invalid/no-op.
   */
  public async renameTag(oldTag: string, newTag: string): Promise<BulkSaveResult | null> {
    const cleanOld = oldTag.trim().replace(/^#/, '');
    const cleanNew = newTag.trim().replace(/^#/, '');
    if (!cleanOld || !cleanNew || cleanOld === cleanNew) return null;

    const affected = this.getDocs().filter(d => (d.tags || []).includes(cleanOld));
    const result = await this.applyTagUpdateToDocs(
      affected,
      tags => Array.from(new Set(tags.map(tag => (tag === cleanOld ? cleanNew : tag)))),
      `重命名标签 ${cleanOld} → ${cleanNew}`
    );

    if (result.failed === 0) {
      this.applyTagCleanupResult(result, await apiClient.deleteTag(cleanOld));
      // Only mirror the rename locally when the server actually removed the old
      // dictionary entry; retained tags mean an unseen document still uses it.
      if (!result.dictionaryCleanupFailed && !result.dictionaryRetained) {
        this.updateCustomTags(list => list.map(tag => (tag === cleanOld ? cleanNew : tag)));
      }
    }

    return result;
  }

  /** Remove a tag from all documents through the confirmed save path. */
  public async deleteTag(tagName: string): Promise<BulkSaveResult> {
    const cleanTag = tagName.trim().replace(/^#/, '');
    if (!cleanTag) return { total: 0, succeeded: 0, failed: 0, errors: [] };

    const affected = this.getDocs().filter(d => (d.tags || []).includes(cleanTag));
    const result = await this.applyTagUpdateToDocs(
      affected,
      tags => tags.filter(tag => tag !== cleanTag),
      `删除标签 ${cleanTag}`
    );

    if (result.failed === 0) {
      this.applyTagCleanupResult(result, await apiClient.deleteTag(cleanTag));
      if (!result.dictionaryCleanupFailed && !result.dictionaryRetained) {
        this.updateCustomTags(list => list.filter(tag => tag !== cleanTag));
      }
    }

    return result;
  }

  /** Merge one tag into another across all documents through the confirmed save path. */
  public async mergeTags(fromTag: string, toTag: string): Promise<BulkSaveResult | null> {
    const cleanFrom = fromTag.trim().replace(/^#/, '');
    const cleanTo = toTag.trim().replace(/^#/, '');
    if (!cleanFrom || !cleanTo || cleanFrom === cleanTo) return null;

    const affected = this.getDocs().filter(d => (d.tags || []).includes(cleanFrom));
    const result = await this.applyTagUpdateToDocs(
      affected,
      tags => {
        const next = tags.filter(tag => tag !== cleanFrom);
        if (!next.includes(cleanTo)) next.push(cleanTo);
        return next;
      },
      `合并标签 ${cleanFrom} → ${cleanTo}`
    );

    if (result.failed === 0) {
      this.applyTagCleanupResult(result, await apiClient.deleteTag(cleanFrom));
      if (!result.dictionaryCleanupFailed && !result.dictionaryRetained) {
        this.updateCustomTags(list => {
          const next = list.filter(tag => tag !== cleanFrom);
          if (!next.includes(cleanTo)) next.push(cleanTo);
          return next;
        });
      }
    }

    return result;
  }

  public cleanUnusedTags(): number {
    const docs = this.getDocs();
    const activeTags = new Set<string>();
    docs.forEach(d => (d.tags || []).forEach(t => activeTags.add(t)));

    let removedCount = 0;
    try {
      const data = localStorage.getItem('inkflow_custom_tags_v1');
      if (data) {
        const list: string[] = JSON.parse(data);
        const retained = list.filter(t => activeTags.has(t));
        removedCount = list.length - retained.length;
        localStorage.setItem('inkflow_custom_tags_v1', JSON.stringify(retained));
      }
    } catch {}
    return removedCount;
  }

  // --- Version Control ---

  public getVersions(docId?: string): DocVersion[] {
    if (!this.versionsCache) {
      try {
        const data = localStorage.getItem(STORAGE_KEYS.VERSIONS);
        this.versionsCache = data ? JSON.parse(data) : INITIAL_VERSIONS;
      } catch {
        this.versionsCache = INITIAL_VERSIONS;
      }
    }
    const all = this.versionsCache || [];
    if (!docId) return all;
    return all
      .filter(v => v.docId === docId)
      .sort((a, b) => b.versionNumber - a.versionNumber);
  }

  public createVersionSnapshot(doc: KnowledgeDoc, note: string = '手动创建快照'): DocVersion {
    const all = this.getVersions();
    const docVersions = all.filter(v => v.docId === doc.id);
    const nextVer = docVersions.length > 0 ? Math.max(...docVersions.map(v => v.versionNumber)) + 1 : 1;

    const newSnapshot: DocVersion = {
      id: `ver-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      docId: doc.id,
      versionNumber: nextVer,
      title: doc.title,
      rawMarkdown: doc.rawMarkdown,
      timestamp: new Date().toISOString(),
      note,
      charCount: doc.rawMarkdown.length,
    };

    all.unshift(newSnapshot);
    this.persistVersions(all);
    return newSnapshot;
  }

  public async revertToVersion(docId: string, versionId: string): Promise<SaveDocResult | null> {
    const version = this.getVersions().find(v => v.id === versionId && v.docId === docId);
    if (!version) return null;

    const doc = this.getDocById(docId);
    if (!doc) return null;

    return this.saveDoc(
      {
        ...doc,
        title: version.title,
        rawMarkdown: version.rawMarkdown,
      },
      `回滚到版本 v${version.versionNumber} (${new Date(version.timestamp).toLocaleString('zh-CN')})`
    );
  }

  private persistVersions(versions: DocVersion[]): void {
    this.versionsCache = versions;
    localStorage.setItem(STORAGE_KEYS.VERSIONS, JSON.stringify(versions));
  }

  // --- Attachments ---

  public getAttachments(docId?: string): Attachment[] {
    if (!this.attachmentsCache) {
      try {
        const data = localStorage.getItem(STORAGE_KEYS.ATTACHMENTS);
        this.attachmentsCache = data ? JSON.parse(data) : [];
      } catch {
        this.attachmentsCache = [];
      }
    }
    const list = this.attachmentsCache || [];
    if (docId) {
      return list.filter(a => a.docId === docId);
    }
    return list;
  }

  public saveAttachment(attachment: Attachment): void {
    const list = this.getAttachments();
    const idx = list.findIndex(a => a.id === attachment.id);
    if (idx >= 0) {
      list[idx] = attachment;
    } else {
      list.unshift(attachment);
    }
    this.attachmentsCache = list;
    localStorage.setItem(STORAGE_KEYS.ATTACHMENTS, JSON.stringify(list));
  }

  public deleteAttachment(id: string): void {
    const list = this.getAttachments().filter(a => a.id !== id);
    this.attachmentsCache = list;
    localStorage.setItem(STORAGE_KEYS.ATTACHMENTS, JSON.stringify(list));
  }

  // --- Comments & Reader Discussions ---

  public getComments(docId?: string): CommentItem[] {
    if (!this.commentsCache) {
      try {
        const data = localStorage.getItem(STORAGE_KEYS.COMMENTS);
        this.commentsCache = data ? JSON.parse(data) : INITIAL_COMMENTS;
      } catch {
        this.commentsCache = INITIAL_COMMENTS;
      }
    }
    const list = this.commentsCache || [];
    if (docId) {
      return list
        .filter(c => c.docId === docId)
        .sort((a, b) => {
          if (a.isPinned && !b.isPinned) return -1;
          if (!a.isPinned && b.isPinned) return 1;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });
    }
    return list;
  }

  public addComment(comment: Omit<CommentItem, 'id' | 'createdAt' | 'upvotes'>): CommentItem {
    const list = this.commentsCache || INITIAL_COMMENTS;
    const newComment: CommentItem = {
      ...comment,
      id: `comm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
      upvotes: 0,
    };
    list.unshift(newComment);
    this.commentsCache = list;
    localStorage.setItem(STORAGE_KEYS.COMMENTS, JSON.stringify(list));
    return newComment;
  }

  public upvoteComment(id: string): void {
    const list = this.commentsCache || [];
    const item = list.find(c => c.id === id);
    if (item) {
      item.upvotes = (item.upvotes || 0) + 1;
      localStorage.setItem(STORAGE_KEYS.COMMENTS, JSON.stringify(list));
    }
  }

  public deleteComment(id: string): void {
    const list = (this.commentsCache || []).filter(c => c.id !== id);
    this.commentsCache = list;
    localStorage.setItem(STORAGE_KEYS.COMMENTS, JSON.stringify(list));
  }

  // --- Knowledge Forum / Discourse Topics ---

  public getForumTopics(): ForumTopic[] {
    if (!this.topicsCache) {
      try {
        const data = localStorage.getItem(STORAGE_KEYS.FORUM_TOPICS);
        this.topicsCache = data ? JSON.parse(data) : INITIAL_FORUM_TOPICS;
      } catch {
        this.topicsCache = INITIAL_FORUM_TOPICS;
      }
    }
    return (this.topicsCache || []).sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  public getForumTopicById(id: string): ForumTopic | undefined {
    return this.getForumTopics().find(t => t.id === id);
  }

  public createForumTopic(input: Omit<ForumTopic, 'id' | 'createdAt' | 'replyCount' | 'upvotes'>): ForumTopic {
    const list = this.getForumTopics();
    const newTopic: ForumTopic = {
      ...input,
      id: `topic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
      replyCount: 0,
      upvotes: 0,
    };
    list.unshift(newTopic);
    this.topicsCache = list;
    localStorage.setItem(STORAGE_KEYS.FORUM_TOPICS, JSON.stringify(list));
    return newTopic;
  }

  public upvoteTopic(id: string): void {
    const list = this.getForumTopics();
    const topic = list.find(t => t.id === id);
    if (topic) {
      topic.upvotes = (topic.upvotes || 0) + 1;
      localStorage.setItem(STORAGE_KEYS.FORUM_TOPICS, JSON.stringify(list));
    }
  }

  public toggleTopicResolved(id: string): void {
    const list = this.getForumTopics();
    const topic = list.find(t => t.id === id);
    if (topic) {
      topic.isResolved = !topic.isResolved;
      localStorage.setItem(STORAGE_KEYS.FORUM_TOPICS, JSON.stringify(list));
    }
  }

  public getForumReplies(topicId: string): ForumReply[] {
    if (!this.repliesCache) {
      try {
        const data = localStorage.getItem(STORAGE_KEYS.FORUM_REPLIES);
        this.repliesCache = data ? JSON.parse(data) : INITIAL_FORUM_REPLIES;
      } catch {
        this.repliesCache = INITIAL_FORUM_REPLIES;
      }
    }
    return (this.repliesCache || [])
      .filter(r => r.topicId === topicId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  public addForumReply(input: Omit<ForumReply, 'id' | 'createdAt' | 'upvotes'>): ForumReply {
    const list = this.repliesCache || INITIAL_FORUM_REPLIES;
    const newReply: ForumReply = {
      ...input,
      id: `reply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
      upvotes: 0,
    };
    list.push(newReply);
    this.repliesCache = list;
    localStorage.setItem(STORAGE_KEYS.FORUM_REPLIES, JSON.stringify(list));

    // Update topic reply count
    const topics = this.getForumTopics();
    const topic = topics.find(t => t.id === input.topicId);
    if (topic) {
      topic.replyCount = (topic.replyCount || 0) + 1;
      localStorage.setItem(STORAGE_KEYS.FORUM_TOPICS, JSON.stringify(topics));
    }

    return newReply;
  }

  // --- Import / Export ---

  public async importMarkdownText(
    content: string,
    filename?: string
  ): Promise<SaveDocResult> {
    const { frontmatter } = parseFrontmatter(content);
    const title = frontmatter.title || (filename ? filename.replace(/\.md$/i, '') : extractTitle(content));
    const category = frontmatter.category || '未分类';
    const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
    const visibility = (['public', 'private', 'unlisted'].includes(frontmatter.visibility)
      ? frontmatter.visibility
      : 'private') as KnowledgeDoc['visibility'];
    // Imported Markdown never publishes itself: new imports start as drafts (SEC-011).
    const status = (['draft', 'published', 'archived'].includes(frontmatter.status)
      ? frontmatter.status
      : 'draft') as KnowledgeDoc['status'];

    return this.saveDoc(
      {
        title,
        rawMarkdown: content,
        category,
        tags,
        visibility,
        status,
        unlistedKey: frontmatter.unlistedKey,
        author: frontmatter.author || 'Owner',
      },
      `导入 Markdown 文件: ${filename || title}`
    );
  }

  public async importMarkdownFiles(files: FileList): Promise<KnowledgeDoc[]> {
    const results: KnowledgeDoc[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const text = await file.text();
        const result = await this.importMarkdownText(text, file.name);
        if (result.success) results.push(result.doc);
        else console.error('Failed importing file', file.name, result.error);
      } catch (e) {
        console.error('Failed reading file', file.name, e);
      }
    }
    return results;
  }

  public async exportAllAsZip(): Promise<Blob> {
    const zip = new JSZip();
    const docs = this.getDocs();
    const attachments = this.getAttachments();

    for (const doc of docs) {
      const folderName = (doc.category || '未分类').replace(/[\/\\:*?"<>|]/g, '_');
      const safeTitle = (doc.title || doc.slug).replace(/[\/\\:*?"<>|]/g, '_');
      const filename = `${safeTitle}.md`;
      const fullMarkdown = serializeToMarkdown(doc);
      zip.file(`${folderName}/${filename}`, fullMarkdown);
    }

    if (attachments.length > 0) {
      const attFolder = zip.folder('attachments');
      if (attFolder) {
        for (const att of attachments) {
          if (att.dataUrl && att.dataUrl.includes('base64,')) {
            const base64Data = att.dataUrl.split('base64,')[1];
            attFolder.file(att.name, base64Data, { base64: true });
          }
        }
      }
    }

    const manifest = {
      exportTime: new Date().toISOString(),
      app: 'InkFlow Knowledge Base',
      version: '1.2.0',
      totalDocs: docs.length,
      categories: this.getCategories(),
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    return await zip.generateAsync({ type: 'blob' });
  }

  public exportFullBackupJson(): string {
    const backup = {
      version: '1.2.0',
      exportedAt: new Date().toISOString(),
      docs: this.getDocs(),
      categories: this.getCategories(),
      versions: this.getVersions(),
      attachments: this.getAttachments(),
      comments: this.getComments(),
      forumTopics: this.getForumTopics(),
      forumReplies: this.repliesCache || [],
    };
    return JSON.stringify(backup, null, 2);
  }

  public importFullBackupJson(jsonString: string): { success: boolean; docCount: number; message: string } {
    try {
      const data = JSON.parse(jsonString);
      if (!data || !Array.isArray(data.docs)) {
        return { success: false, docCount: 0, message: '备份文件格式不正确，缺少有效的文档数据' };
      }
      this.persistDocs(data.docs);
      if (Array.isArray(data.categories)) {
        this.categoriesCache = data.categories;
        localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(data.categories));
      }
      if (Array.isArray(data.versions)) {
        this.persistVersions(data.versions);
      }
      if (Array.isArray(data.attachments)) {
        this.attachmentsCache = data.attachments;
        localStorage.setItem(STORAGE_KEYS.ATTACHMENTS, JSON.stringify(data.attachments));
      }
      if (Array.isArray(data.comments)) {
        this.commentsCache = data.comments;
        localStorage.setItem(STORAGE_KEYS.COMMENTS, JSON.stringify(data.comments));
      }
      if (Array.isArray(data.forumTopics)) {
        this.topicsCache = data.forumTopics;
        localStorage.setItem(STORAGE_KEYS.FORUM_TOPICS, JSON.stringify(data.forumTopics));
      }
      if (Array.isArray(data.forumReplies)) {
        this.repliesCache = data.forumReplies;
        localStorage.setItem(STORAGE_KEYS.FORUM_REPLIES, JSON.stringify(data.forumReplies));
      }
      return { success: true, docCount: data.docs.length, message: `成功恢复 ${data.docs.length} 篇文档及相关配置！` };
    } catch (err: any) {
      return { success: false, docCount: 0, message: `解析备份文件失败: ${err?.message || '未知错误'}` };
    }
  }

  public resetToDefault(): void {
    localStorage.removeItem(STORAGE_KEYS.DOCS);
    localStorage.removeItem(STORAGE_KEYS.CATEGORIES);
    localStorage.removeItem(STORAGE_KEYS.VERSIONS);
    localStorage.removeItem(STORAGE_KEYS.ATTACHMENTS);
    localStorage.removeItem(STORAGE_KEYS.COMMENTS);
    localStorage.removeItem(STORAGE_KEYS.FORUM_TOPICS);
    localStorage.removeItem(STORAGE_KEYS.FORUM_REPLIES);
    this.docsCache = null;
    this.categoriesCache = null;
    this.versionsCache = null;
    this.attachmentsCache = null;
    this.commentsCache = null;
    this.topicsCache = null;
    this.repliesCache = null;
    this.init();
  }

  // --- Auth / Session ---

  public getSession(): UserSession {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.SESSION);
      if (data) return JSON.parse(data);
    } catch {}
    return {
      isOwner: false,
      username: '探索读者 (Visitor)',
      role: 'reader',
    };
  }

  public setSession(session: UserSession): void {
    localStorage.setItem(STORAGE_KEYS.SESSION, JSON.stringify(session));
  }

  public switchRole(role: UserRole): UserSession {
    const current = this.getSession();
    let session: UserSession;
    if (role === 'owner') {
      // Owner role requires an authenticated session token
      if (current.token && current.isOwner) {
        session = current;
      } else {
        // Not authenticated as owner, fallback to reader
        session = {
          isOwner: false,
          username: '探索读者 (Reader)',
          role: 'reader',
        };
      }
    } else if (role === 'contributor') {
      session = {
        isOwner: false,
        username: 'Alex Lin (特邀共创者)',
        role: 'contributor',
      };
    } else {
      session = {
        isOwner: false,
        username: '探索读者 (Reader)',
        role: 'reader',
      };
    }
    this.setSession(session);
    return session;
  }

  public async verifyAndLogin(passcode: string): Promise<{ success: boolean; message?: string }> {
    try {
      const res = await apiClient.login(passcode);
      if (res.data?.token) {
        this.loginAsOwner(res.data.token, res.data.user?.username);
        return { success: true };
      }
      return { success: false, message: res.error?.message || '访问密钥错误，认证失败' };
    } catch (e: any) {
      return { success: false, message: e.message || '网络连接或认证异常' };
    }
  }

  public async initOwner(params: {
    initKey: string;
    username?: string;
    password: string;
    email?: string;
  }): Promise<{ success: boolean; message?: string; recoveryCode?: string }> {
    try {
      const res = await apiClient.initOwner(params);
      if (res.data?.token) {
        this.loginAsOwner(res.data.token, res.data.user?.username);
        return {
          success: true,
          recoveryCode: res.data.recoveryCode,
          message: res.data.message || '主理人初始化成功',
        };
      }
      return { success: false, message: res.error?.message || '初始化失败' };
    } catch (e: any) {
      return { success: false, message: e.message || '网络连接异常' };
    }
  }

  public async updateOwnerPassword(newSecret: string): Promise<boolean> {
    try {
      const res = await apiClient.changePassword(newSecret);
      return Boolean(res.data?.success);
    } catch {
      return false;
    }
  }

  public async resetPassword(params: {
    username?: string;
    oldPassword?: string;
    recoveryCode?: string;
    newPassword: string;
  }): Promise<{ success: boolean; message: string; newRecoveryCode?: string }> {
    try {
      const res = await apiClient.resetPassword(params);
      if (res.data?.success) {
        return {
          success: true,
          message: res.data.message || '密码重置成功，请重新登录',
          newRecoveryCode: res.data.newRecoveryCode,
        };
      }
      return { success: false, message: res.error?.message || '密码重置失败' };
    } catch (e: any) {
      return { success: false, message: e.message || '网络请求异常' };
    }
  }

  public logoutOwner(): void {
    apiClient.logout().catch(() => {});
    const readerSession: UserSession = {
      isOwner: false,
      username: '探索读者 (Reader)',
      role: 'reader',
    };
    this.setSession(readerSession);
  }

  public loginAsOwner(token: string, username?: string): void {
    const session: UserSession = {
      isOwner: true,
      username: username ? `${username} (主理人)` : 'Hecker (知识库主理人)',
      role: 'owner',
      token,
    };
    this.setSession(session);
    apiClient.setToken(token);
  }
}


export const storage = new StorageService();
