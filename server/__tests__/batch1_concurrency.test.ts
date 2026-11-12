import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { authService } from '../services/authService';
import { documentService } from '../services/documentService';
import { assetService } from '../services/assetService';
import { consistencyGate } from '../services/consistencyGate';
import { getDatabase, closeDatabase } from '../db/sqlite';

const testDbPath = path.join(
  os.tmpdir(),
  `inkflow_batch1_stress_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
);
const testDataDir = path.join(
  os.tmpdir(),
  `inkflow_batch1_stress_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const INIT_KEY = 'batch1-concurrency-init-key-abcdef0123456789';
process.env.INKFLOW_DB_PATH = testDbPath;
process.env.INKFLOW_DATA_DIR = testDataDir;
process.env.INKFLOW_INIT_KEY = INIT_KEY;

let db: any;
let ownerId: string;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

async function createDoc(index: number) {
  const id = `doc_stress_${index}_${crypto.randomBytes(3).toString('hex')}`;
  return documentService.saveDocument(
    {
      id,
      title: `并发压力文档 ${index}`,
      slug: `stress-${index}-${crypto.randomBytes(3).toString('hex')}`,
      rawMarkdown: `# 并发压力 ${index}\n\n初始正文`,
      category: '安全与数据主权',
      tags: ['并发', `批次-${index % 3}`],
      visibility: 'private',
      status: 'draft',
    },
    ownerId,
    '并发压力初始化'
  );
}

describe('Batch 1 consistency gate under real service concurrency', () => {
  beforeAll(() => {
    closeDatabase();
    db = getDatabase();
    const init = authService.initializeOwner({
      initKey: INIT_KEY,
      username: 'batch1_stress_owner',
      password: 'Batch1StressPassword!',
      email: 'batch1-stress@inkflow.local',
    });
    expect(init.success).toBe(true);
    ownerId = init.user.id;
  });

  afterAll(() => {
    closeDatabase();
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        const p = `${testDbPath}${suffix}`;
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('runs saves, deletes, asset writes, cleanup and exclusive maintenance without deadlock', async () => {
    const docs = [];
    for (let i = 0; i < 12; i++) {
      docs.push(await createDoc(i));
    }

    // Add a second revision to the first half so revision files exist too.
    for (let i = 0; i < 6; i++) {
      const doc = docs[i];
      await documentService.saveDocument(
        {
          id: doc.id,
          title: doc.title,
          slug: doc.slug,
          rawMarkdown: `# 并发压力 ${i}\n\n第二版正文`,
          category: '安全与数据主权',
          tags: ['并发'],
          visibility: 'private',
          status: 'draft',
          expectedVersionCount: doc.versionCount,
        },
        ownerId,
        '并发压力第二版'
      );
    }

    const toDelete = docs.slice(6, 9);
    const toSave = docs.slice(9, 12);

    const operations: Promise<unknown>[] = [];

    // Parallel saves on distinct documents.
    for (let i = 0; i < toSave.length; i++) {
      const doc = toSave[i];
      operations.push(
        documentService.saveDocument(
          {
            id: doc.id,
            title: doc.title,
            slug: doc.slug,
            rawMarkdown: `# 并发保存 ${i}\n\n并行写入`,
            category: '安全与数据主权',
            tags: ['并发'],
            visibility: 'private',
            status: 'draft',
            expectedVersionCount: doc.versionCount,
          },
          ownerId,
          '并行保存'
        )
      );
    }

    // Parallel deletes on distinct documents.
    for (const doc of toDelete) {
      operations.push(documentService.deleteDocument(doc.id));
    }

    // Asset uploads, list/reconcile and orphan cleanup.
    for (let i = 0; i < 8; i++) {
      operations.push(
        assetService.uploadAsset({
          originalName: `stress-${i}.png`,
          mimeType: 'image/png',
          buffer: Buffer.from(`asset-content-${i}`),
          ownerId,
        })
      );
    }
    operations.push(assetService.listAssets());
    operations.push(assetService.listAssets());
    operations.push(assetService.cleanupUnreferencedAssets());

    // Whole-library rebuild and exclusive probes compete with the writes above.
    operations.push(documentService.rebuildAssetReferences());
    for (let i = 0; i < 10; i++) {
      operations.push(
        consistencyGate.withExclusive(async () => {
          await new Promise(resolve => setTimeout(resolve, 1));
        })
      );
    }

    const results = await withTimeout(Promise.allSettled(operations), 20000, 'service concurrency');
    const rejected = results.filter(result => result.status === 'rejected') as PromiseRejectedResult[];
    if (rejected.length > 0) {
      throw new Error(`并发操作失败 ${rejected.length} 个：${rejected.map(r => r.reason?.message || r.reason).join('; ')}`);
    }

    expect(consistencyGate.snapshot()).toMatchObject({ readers: 0, writing: false, queued: 0 });

    // Every surviving document row still has its Markdown file.
    const rows = db.prepare('SELECT id FROM documents').all() as any[];
    for (const row of rows) {
      const file = path.join(testDataDir, 'documents', row.id, 'index.md');
      expect(fs.existsSync(file)).toBe(true);
    }

    // Every revision row still has its snapshot file.
    const revisions = db.prepare('SELECT document_id, id FROM document_revisions').all() as any[];
    for (const revision of revisions) {
      const file = path.join(testDataDir, 'revisions', revision.document_id, `${revision.id}.md`);
      expect(fs.existsSync(file)).toBe(true);
    }

    // Deleted documents are gone from both DB and disk.
    for (const doc of toDelete) {
      expect(db.prepare('SELECT id FROM documents WHERE id = ?').get(doc.id)).toBeUndefined();
      expect(fs.existsSync(path.join(testDataDir, 'documents', doc.id))).toBe(false);
    }
  }, 30000);
});
