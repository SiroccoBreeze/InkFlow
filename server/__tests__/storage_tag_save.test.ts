import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Tag maintenance must use the same server-confirmed save path as the editor:
 * no local-only success, no ignored version conflicts, and partial failures are
 * reported with the failed documents left untouched.
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

function makeDoc(id: string, tags: string[]) {
  return {
    id,
    slug: id,
    title: `文档 ${id}`,
    rawMarkdown: `# 文档 ${id}\n\n正文`,
    category: '安全与数据主权',
    tags,
    visibility: 'private' as const,
    status: 'draft' as const,
    author: 'Owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    versionCount: 1,
    wordCount: 4,
    readingTimeMinutes: 1,
    pinned: false,
    attachments: [],
  };
}

function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('StorageService tag maintenance save path', () => {
  let localStorageMock: MemoryStorage;
  let fetchMock: ReturnType<typeof vi.fn>;
  let StorageServiceClass: typeof import('../../src/services/storage').StorageService;
  let apiClient: typeof import('../../src/services/apiClient').apiClient;
  let conflictIds: Set<string>;

  beforeEach(async () => {
    vi.resetModules();
    localStorageMock = new MemoryStorage();
    (globalThis as any).localStorage = localStorageMock;
    localStorageMock.setItem(
      'inkflow_docs_v1',
      JSON.stringify([makeDoc('doc_a', ['old', 'keep']), makeDoc('doc_b', ['old'])])
    );
    localStorageMock.setItem('inkflow_versions_v1', JSON.stringify([]));
    localStorageMock.setItem('inkflow_custom_tags_v1', JSON.stringify(['old', 'keep']));

    conflictIds = new Set();
    fetchMock = vi.fn(async (url: string, init: any = {}) => {
      const method = init.method || 'GET';
      if (method === 'PUT') {
        const body = JSON.parse(init.body);
        if (conflictIds.has(body.id)) {
          return jsonResponse(409, {
            error: { code: 'VERSION_CONFLICT', message: 'version conflict' },
          });
        }
        return jsonResponse(200, {
          data: {
            ...body,
            versionCount: (body.expectedVersionCount || 0) + 1,
            readingTime: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: new Date().toISOString(),
          },
        });
      }
      if (method === 'DELETE') {
        return jsonResponse(200, { data: { success: true } });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: `unhandled ${url}` } });
    });
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

  it('renames a tag through confirmed saves and only then cleans up the dictionary', async () => {
    const svc = new StorageServiceClass();
    const result = await svc.renameTag('old', 'new');

    expect(result).toMatchObject({ total: 2, succeeded: 2, failed: 0 });
    expect(svc.getDocById('doc_a')!.tags).toEqual(['new', 'keep']);
    expect(svc.getDocById('doc_b')!.tags).toEqual(['new']);

    const calls = fetchMock.mock.calls.map(([url, init]: any) => ({ url, method: init?.method || 'GET' }));
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(2);
    expect(calls.filter(c => c.method === 'DELETE')).toEqual([{ url: '/api/v1/tags/old', method: 'DELETE' }]);
    // Dictionary cleanup must happen after both document saves.
    expect(calls[calls.length - 1]).toEqual({ url: '/api/v1/tags/old', method: 'DELETE' });

    const putBodies = fetchMock.mock.calls
      .filter(([, init]: any) => init?.method === 'PUT')
      .map(([, init]: any) => JSON.parse(init.body));
    expect(putBodies.every((body: any) => body.expectedVersionCount === 1)).toBe(true);

    expect(JSON.parse(localStorageMock.getItem('inkflow_custom_tags_v1')!)).toEqual(['new', 'keep']);
  });

  it('reports partial delete failures and never reports local success for failed documents', async () => {
    conflictIds.add('doc_b');
    const svc = new StorageServiceClass();

    const promise = svc.deleteTag('old');
    // Not yet confirmed: the local cache must still show the old tag.
    expect(svc.getDocById('doc_a')!.tags).toContain('old');

    const result = await promise;
    expect(result).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
    expect(result.errors[0]?.code).toBe('VERSION_CONFLICT');

    expect(svc.getDocById('doc_a')!.tags).toEqual(['keep']);
    // Failed document keeps its tag: no optimistic local mutation.
    expect(svc.getDocById('doc_b')!.tags).toEqual(['old']);

    const deleteCalls = fetchMock.mock.calls.filter(([, init]: any) => init?.method === 'DELETE');
    expect(deleteCalls).toHaveLength(0);
    expect(JSON.parse(localStorageMock.getItem('inkflow_custom_tags_v1')!)).toEqual(['old', 'keep']);
  });

  it('leaves every document untouched when all renames conflict', async () => {
    conflictIds.add('doc_a');
    conflictIds.add('doc_b');
    const svc = new StorageServiceClass();

    const result = await svc.renameTag('old', 'new');

    expect(result).toMatchObject({ total: 2, succeeded: 0, failed: 2 });
    expect(svc.getDocById('doc_a')!.tags).toEqual(['old', 'keep']);
    expect(svc.getDocById('doc_b')!.tags).toEqual(['old']);
    expect(fetchMock.mock.calls.every(([, init]: any) => init?.method !== 'DELETE')).toBe(true);
    expect(JSON.parse(localStorageMock.getItem('inkflow_custom_tags_v1')!)).toEqual(['old', 'keep']);
  });

  it('merges tags via confirmed saves, then removes the source tag from the dictionary', async () => {
    const svc = new StorageServiceClass();
    const result = await svc.mergeTags('old', 'new');

    expect(result).toMatchObject({ total: 2, succeeded: 2, failed: 0 });
    expect(svc.getDocById('doc_a')!.tags).toEqual(['keep', 'new']);
    expect(svc.getDocById('doc_b')!.tags).toEqual(['new']);

    const deleteCalls = fetchMock.mock.calls.filter(([, init]: any) => init?.method === 'DELETE');
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toBe('/api/v1/tags/old');
    expect(JSON.parse(localStorageMock.getItem('inkflow_custom_tags_v1')!)).toEqual(['keep', 'new']);
  });
});
