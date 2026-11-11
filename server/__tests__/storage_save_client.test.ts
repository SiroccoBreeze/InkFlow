import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Front-end save contract: the local cache may only reflect a save AFTER the
 * server confirms it. These tests stub fetch/localStorage (no jsdom dependency)
 * to cover success, server errors, network loss, conflicts, queueing and dedupe.
 */

class MemoryStorage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
  key(index: number) {
    return Array.from(this.data.keys())[index] ?? null;
  }
}

const BASE_DOC = {
  id: 'doc_client_save',
  slug: 'doc-client-save',
  title: '客户端保存测试',
  rawMarkdown: '# 客户端保存测试\n\nold',
  category: '安全与数据主权',
  tags: ['保存'],
  visibility: 'private' as const,
  status: 'draft' as const,
  author: 'Owner',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  versionCount: 3,
  wordCount: 10,
  readingTimeMinutes: 1,
  pinned: false,
  attachments: [],
};

function serverDoc(expectedVersionCount: number, rawMarkdown: string) {
  return {
    ...BASE_DOC,
    rawMarkdown,
    versionCount: expectedVersionCount + 1,
    updatedAt: new Date().toISOString(),
  };
}

function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('StorageService save reliability (client side)', () => {
  let localStorageMock: MemoryStorage;
  let fetchMock: ReturnType<typeof vi.fn>;
  let StorageServiceClass: typeof import('../../src/services/storage').StorageService;
  let apiClient: typeof import('../../src/services/apiClient').apiClient;

  beforeEach(async () => {
    vi.resetModules();
    localStorageMock = new MemoryStorage();
    (globalThis as any).localStorage = localStorageMock;
    localStorageMock.setItem('inkflow_docs_v1', JSON.stringify([BASE_DOC]));
    localStorageMock.setItem('inkflow_versions_v1', JSON.stringify([]));

    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;

    const storageModule = await import('../../src/services/storage');
    const apiModule = await import('../../src/services/apiClient');
    StorageServiceClass = storageModule.StorageService;
    apiClient = apiModule.apiClient;
    apiClient.setToken('test-token');
  });

  afterEach(() => {
    delete (globalThis as any).localStorage;
    delete (globalThis as any).fetch;
    vi.restoreAllMocks();
  });

  it('updates the local cache only after a confirmed server save', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: serverDoc(3, '---\nid: "doc_client_save"\n---\n\n# 客户端保存测试\n\nnew') })
    );

    const svc = new StorageServiceClass();
    const result = await svc.saveDoc(
      { id: BASE_DOC.id, title: BASE_DOC.title, rawMarkdown: '# 客户端保存测试\n\nnew' },
      '测试保存'
    );

    expect(result.success).toBe(true);
    expect(result.serverSaved).toBe(true);
    expect(result.doc.versionCount).toBe(4);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/documents/doc_client_save');
    expect(init.method).toBe('PUT');
    const sent = JSON.parse(init.body);
    expect(sent.expectedVersionCount).toBe(3);
    expect(init.headers.Authorization).toBe('Bearer test-token');

    const localDoc = svc.getDocById(BASE_DOC.id)!;
    expect(localDoc.versionCount).toBe(4);
    expect(localDoc.rawMarkdown).toContain('\n\nnew');
    const persisted = JSON.parse(localStorageMock.getItem('inkflow_docs_v1')!);
    expect(persisted[0].versionCount).toBe(4);
    expect(svc.getVersions(BASE_DOC.id).length).toBe(1);
  });

  it('keeps the local cache unchanged and reports a retryable error on HTTP 500', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { code: 'SAVE_FAILED', message: 'disk I/O error' } }));

    const svc = new StorageServiceClass();
    const result = await svc.saveDoc(
      { id: BASE_DOC.id, title: BASE_DOC.title, rawMarkdown: '# 客户端保存测试\n\nnew' },
      '测试保存'
    );

    expect(result.success).toBe(false);
    expect(result.serverSaved).toBe(false);
    expect(result.error?.code).toBe('SERVER_ERROR');
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.message).toContain('内容仍保留');

    const localDoc = svc.getDocById(BASE_DOC.id)!;
    expect(localDoc.rawMarkdown).toBe(BASE_DOC.rawMarkdown);
    expect(localDoc.versionCount).toBe(3);
    expect(svc.getVersions(BASE_DOC.id).length).toBe(0);
  });

  it('treats a network failure as retryable and preserves the edit', async () => {
    fetchMock.mockRejectedValue(new Error('Failed to fetch'));

    const svc = new StorageServiceClass();
    const result = await svc.saveDoc(
      { id: BASE_DOC.id, title: BASE_DOC.title, rawMarkdown: '# 客户端保存测试\n\nnew' },
      '测试保存'
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NETWORK_ERROR');
    expect(result.error?.retryable).toBe(true);
    expect(svc.getDocById(BASE_DOC.id)!.rawMarkdown).toBe(BASE_DOC.rawMarkdown);
  });

  it('surfaces a 409 version conflict as non-retryable and leaves local data intact', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'VERSION_CONFLICT',
          message: '文档已被其他客户端修改',
          details: { currentVersionCount: 9 },
        },
      })
    );

    const svc = new StorageServiceClass();
    const result = await svc.saveDoc(
      { id: BASE_DOC.id, title: BASE_DOC.title, rawMarkdown: '# 客户端保存测试\n\nnew' },
      '测试保存'
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VERSION_CONFLICT');
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.details.currentVersionCount).toBe(9);
    expect(svc.getDocById(BASE_DOC.id)!.versionCount).toBe(3);
  });

  it('blocks retry and preserves edits when the server requires recovery', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, {
        error: {
          code: 'SAVE_RECOVERY_REQUIRED',
          message: '文档存在未完成的保存恢复任务',
          details: { docId: BASE_DOC.id },
        },
      })
    );

    const svc = new StorageServiceClass();
    const result = await svc.saveDoc(
      { id: BASE_DOC.id, title: BASE_DOC.title, rawMarkdown: '# 客户端保存测试\n\nnew' },
      '测试保存'
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('RECOVERY_REQUIRED');
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.message).toContain('保存已暂停');
    expect(svc.getDocById(BASE_DOC.id)!.rawMarkdown).toBe(BASE_DOC.rawMarkdown);
  });

  it('reports a pending disk cleanup from the delete API', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: { success: true, diskCleanupPending: true } })
    );

    const svc = new StorageServiceClass();
    const result = await svc.deleteDoc(BASE_DOC.id);

    expect(result.success).toBe(true);
    expect(result.diskCleanupPending).toBe(true);
    expect(svc.getDocById(BASE_DOC.id)).toBeUndefined();
  });

  it('blocks save retry when a pending deletion cleanup must finish first', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, {
        error: {
          code: 'DELETE_RECOVERY_REQUIRED',
          message: '文档存在未完成的删除任务',
          details: { docId: BASE_DOC.id },
        },
      })
    );

    const svc = new StorageServiceClass();
    const result = await svc.saveDoc(
      { id: BASE_DOC.id, title: BASE_DOC.title, rawMarkdown: '# 客户端保存测试\n\nnew' },
      '测试保存'
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DELETE_RECOVERY_REQUIRED');
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.message).toContain('删除');
    expect(svc.getDocById(BASE_DOC.id)!.rawMarkdown).toBe(BASE_DOC.rawMarkdown);
  });

  it('queues concurrent saves for the same document so versions stay ordered', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      await new Promise(resolve => setTimeout(resolve, 5));
      return jsonResponse(200, {
        data: serverDoc(body.expectedVersionCount, `# 客户端保存测试\n\n${body.rawMarkdown.slice(-3)}`),
      });
    });

    const svc = new StorageServiceClass();
    const [first, second] = await Promise.all([
      svc.saveDoc({ id: BASE_DOC.id, title: BASE_DOC.title, rawMarkdown: '# 客户端保存测试\n\nv2' }, '第一次'),
      svc.saveDoc({ id: BASE_DOC.id, title: BASE_DOC.title, rawMarkdown: '# 客户端保存测试\n\nv3' }, '第二次'),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const versionsSent = fetchMock.mock.calls.map(([, init]: any) => JSON.parse(init.body).expectedVersionCount);
    expect(versionsSent).toEqual([3, 4]);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(svc.getDocById(BASE_DOC.id)!.versionCount).toBe(5);
  });

  it('deduplicates identical saves that are already in flight', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      await new Promise(resolve => setTimeout(resolve, 5));
      return jsonResponse(200, { data: serverDoc(body.expectedVersionCount, '# 客户端保存测试\n\nsame') });
    });

    const svc = new StorageServiceClass();
    const input = { id: BASE_DOC.id, title: BASE_DOC.title, rawMarkdown: '# 客户端保存测试\n\nsame' };
    const first = svc.saveDoc(input, '重复保存');
    const second = svc.saveDoc(input, '重复保存');
    const [a, b] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(a.doc.versionCount).toBe(b.doc.versionCount);
  });
});
