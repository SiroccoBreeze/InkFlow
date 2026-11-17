import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { authService } from '../services/authService';
import { documentService } from '../services/documentService';
import { assetService } from '../services/assetService';
import { shareService } from '../services/shareService';
import { getDatabase, closeDatabase } from '../db/sqlite';
import { CURRENT_SCHEMA_VERSION, getUserVersion } from '../db/migrations';
import { consistencyGate } from '../services/consistencyGate';
import { normalizeStorageRelativePath } from '../utils/storagePaths';
import { backupService } from '../services/backup/backupService';
import { readBackupManifest, validateBackupManifest } from '../services/backup/backupManifest';
import { sha256File } from '../services/backup/backupSnapshot';
import { BackupError, type BackupManifest } from '../services/backup/types';

const testDbPath = path.join(
  os.tmpdir(),
  `inkflow_backup_db_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
);
const testDataDir = path.join(
  os.tmpdir(),
  `inkflow_backup_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const INIT_KEY = 'backup-infra-init-key-0123456789abcdef';
process.env.INKFLOW_DB_PATH = testDbPath;
process.env.INKFLOW_DATA_DIR = testDataDir;
process.env.INKFLOW_INIT_KEY = INIT_KEY;

const SQL_TABLES = [
  'users',
  'documents',
  'document_revisions',
  'assets',
  'document_assets',
  'document_tags',
  'shares',
  'recovery_codes',
  'categories',
  'tags',
] as const;

let db: any;
let ownerId: string;
let ownerToken = '';
let baseAssetId = '';
let baseAssetDiskName = '';

function tableCount(database: DatabaseSync | any, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any)?.c || 0);
}

function backupsRoot(): string {
  return path.join(testDataDir, 'backups');
}

function finalBackupNames(): string[] {
  if (!fs.existsSync(backupsRoot())) return [];
  return fs
    .readdirSync(backupsRoot(), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('backup-'))
    .map(entry => entry.name)
    .sort();
}

function stagingNames(): string[] {
  const staging = path.join(backupsRoot(), '.staging');
  if (!fs.existsSync(staging)) return [];
  return fs.readdirSync(staging);
}

function expectBackupError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(BackupError);
  expect((caught as BackupError).code).toBe(code);
}

async function expectRejectedBackup(
  promise: Promise<unknown>,
  code: string
): Promise<BackupError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(BackupError);
    expect((err as BackupError).code).toBe(code);
    return err as BackupError;
  }
  throw new Error(`expected backup to fail with ${code}`);
}

async function saveDoc(
  docId: string,
  body: string,
  opts: { visibility?: 'public' | 'private' | 'unlisted'; status?: 'draft' | 'published' | 'archived' } = {}
): Promise<void> {
  await documentService.saveDocument(
    {
      id: docId,
      title: `Backup doc ${docId}`,
      slug: docId,
      rawMarkdown: body,
      category: '安全与数据主权',
      tags: ['备份测试'],
      visibility: opts.visibility ?? 'public',
      status: opts.status ?? 'published',
    },
    ownerId
  );
}

async function uploadAsset(filename: string, content = 'backup-asset-bytes'): Promise<any> {
  return assetService.uploadAsset({
    originalName: filename,
    mimeType: 'image/png',
    buffer: Buffer.from(content, 'utf-8'),
    ownerId,
  });
}

function openSnapshotDb(directory: string, manifest: BackupManifest): DatabaseSync {
  return new DatabaseSync(path.join(directory, ...manifest.database.path.split('/')), {
    readOnly: true,
  });
}

describe('V1.2 Batch 2A backup snapshot infrastructure', () => {
  beforeAll(async () => {
    closeDatabase();
    db = getDatabase();
    const init = authService.initializeOwner({
      initKey: INIT_KEY,
      username: 'backup_owner',
      password: 'BackupOwnerPassword!',
      email: 'backup@inkflow.local',
    });
    expect(init.success).toBe(true);
    ownerId = init.user.id;
    ownerToken = init.token!;

    const asset = await uploadAsset('base-asset.png', 'BASE-ASSET-CONTENT');
    baseAssetId = asset.id;
    baseAssetDiskName = asset.storagePath.split('/')[1];

    await saveDoc(
      'doc_backup_base',
      `# 基础文档\n\n![图](/api/v1/assets/file/${baseAssetId})\n\n第一版正文。`
    );
    // Second save creates a revision snapshot of the first version.
    await saveDoc(
      'doc_backup_base',
      `# 基础文档\n\n![图](/api/v1/assets/file/${baseAssetId})\n\n第二版正文。`
    );

    shareService.createShare({ documentId: 'doc_backup_base', expiresInDays: 3 }, ownerId);
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
      // ignore
    }
  });

  it('creates a self-contained database snapshot that reopens and passes integrity checks', async () => {
    // The fixture must actually exercise the DB↔file hash cross-check.
    expect(
      (db.prepare('SELECT document_hash FROM documents WHERE id = ?').get('doc_backup_base') as any)
        ?.document_hash
    ).toMatch(/^[a-f0-9]{64}$/);
    const result = await backupService.createBackupSnapshot();

    expect(result.directory.startsWith(backupsRoot())).toBe(true);
    expect(fs.existsSync(result.manifestPath)).toBe(true);
    expect(result.manifest.format).toBe('inkflow-backup');
    expect(result.manifest.formatVersion).toBe(1);
    expect(result.manifest.applicationVersion).toBeTruthy();
    expect(result.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.manifest.sessionsExcluded).toBe(true);
    expect(['hardlink', 'copy', 'mixed']).toContain(result.manifest.snapshotMode);
    expect(result.manifest.fileCount).toBe(result.manifest.files.length);

    const snapshot = openSnapshotDb(result.directory, result.manifest);
    try {
      const integrity = snapshot.prepare('PRAGMA integrity_check').all() as any[];
      expect(integrity).toHaveLength(1);
      expect(String(Object.values(integrity[0])[0]).toLowerCase()).toBe('ok');
      expect(getUserVersion(snapshot)).toBe(CURRENT_SCHEMA_VERSION);

      for (const table of SQL_TABLES) {
        expect(tableCount(snapshot, table)).toBe(tableCount(db, table));
      }
      expect(tableCount(snapshot, 'documents_fts')).toBe(tableCount(db, 'documents_fts'));
      expect(tableCount(snapshot, 'documents_fts')).toBeGreaterThan(0);
      expect(tableCount(snapshot, 'sessions')).toBe(0);
      expect(
        (snapshot.prepare('SELECT title FROM documents WHERE id = ?').get('doc_backup_base') as any)?.title
      ).toBe('Backup doc doc_backup_base');
      expect(
        (snapshot.prepare('SELECT COUNT(*) AS c FROM document_revisions').get() as any).c
      ).toBeGreaterThan(0);
    } finally {
      snapshot.close();
    }

    // Markdown, revision and asset content are all present in the snapshot.
    const snapshotMarkdown = fs.readFileSync(
      path.join(result.directory, 'documents', 'doc_backup_base', 'index.md'),
      'utf-8'
    );
    expect(snapshotMarkdown).toContain('第二版正文');
    expect(snapshotMarkdown).toContain(baseAssetId);

    const revisionEntry = result.manifest.files.find(file => file.path.startsWith('revisions/doc_backup_base/'));
    expect(revisionEntry).toBeTruthy();
    expect(fs.existsSync(path.join(result.directory, ...revisionEntry!.path.split('/')))).toBe(true);

    const assetEntry = result.manifest.files.find(file => file.path === `assets/${baseAssetDiskName}`);
    expect(assetEntry).toBeTruthy();
    expect(
      fs.readFileSync(path.join(result.directory, ...assetEntry!.path.split('/')), 'utf-8')
    ).toBe('BASE-ASSET-CONTENT');
  });

  it('round-trips the manifest through the strict reader', async () => {
    const result = await backupService.createBackupSnapshot();
    const reparsed = await readBackupManifest(result.manifestPath);
    expect(reparsed).toEqual(result.manifest);
  });

  it('includes WAL-resident data in the online database snapshot', async () => {
    db.exec('PRAGMA wal_autocheckpoint = 0;');
    try {
      await saveDoc('doc_backup_wal', '# WAL 文档\n\nWAL-ONLY-MARKER');
      const walPath = `${testDbPath}-wal`;
      expect(fs.existsSync(walPath)).toBe(true);
      expect(fs.statSync(walPath).size).toBeGreaterThan(0);

      const result = await backupService.createBackupSnapshot();
      const snapshot = openSnapshotDb(result.directory, result.manifest);
      try {
        const row = snapshot
          .prepare('SELECT title FROM documents WHERE id = ?')
          .get('doc_backup_wal') as any;
        expect(row?.title).toBe('Backup doc doc_backup_wal');
      } finally {
        snapshot.close();
      }
      const markdown = fs.readFileSync(
        path.join(result.directory, 'documents', 'doc_backup_wal', 'index.md'),
        'utf-8'
      );
      expect(markdown).toContain('WAL-ONLY-MARKER');
    } finally {
      db.exec('PRAGMA wal_autocheckpoint = 1000;');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    }
  });

  it('keeps users/shares/recovery codes but removes every session from the copy', async () => {
    const sourceSessionCount = tableCount(db, 'sessions');
    expect(sourceSessionCount).toBeGreaterThan(0);
    const result = await backupService.createBackupSnapshot();
    // The production database must not be modified by session exclusion.
    expect(tableCount(db, 'sessions')).toBe(sourceSessionCount);

    const snapshot = openSnapshotDb(result.directory, result.manifest);
    try {
      expect(tableCount(snapshot, 'sessions')).toBe(0);
      for (const table of ['users', 'recovery_codes', 'shares', 'categories', 'tags'] as const) {
        expect(tableCount(snapshot, table)).toBe(tableCount(db, table));
      }
    } finally {
      snapshot.close();
    }

    // The session token hash must not survive in the copied file's free pages.
    const tokenHash = crypto.createHash('sha256').update(ownerToken).digest('hex');
    const databaseBytes = fs.readFileSync(
      path.join(result.directory, ...result.manifest.database.path.split('/'))
    );
    expect(databaseBytes.includes(Buffer.from(tokenHash))).toBe(false);
  });

  it('records correct SHA-256 and sizes for every file and the database', async () => {
    const result = await backupService.createBackupSnapshot();

    for (const file of result.manifest.files) {
      const absolutePath = path.join(result.directory, ...file.path.split('/'));
      const stat = await fsPromises.stat(absolutePath);
      expect(stat.size).toBe(file.size);
      expect(await sha256File(absolutePath)).toBe(file.sha256);
    }

    const databasePath = path.join(result.directory, ...result.manifest.database.path.split('/'));
    const databaseStat = await fsPromises.stat(databasePath);
    expect(databaseStat.size).toBe(result.manifest.database.size);
    expect(await sha256File(databasePath)).toBe(result.manifest.database.sha256);

    expect(result.manifest.totalSize).toBe(
      result.manifest.files.reduce((sum, file) => sum + file.size, 0)
    );
  });

  it('uses only safe POSIX relative paths in the manifest', async () => {
    const result = await backupService.createBackupSnapshot();
    const allPaths = [result.manifest.database.path, ...result.manifest.files.map(file => file.path)];

    for (const filePath of allPaths) {
      expect(normalizeStorageRelativePath(filePath)).toBe(filePath);
      expect(filePath.includes('\\')).toBe(false);
      expect(path.posix.isAbsolute(filePath)).toBe(false);
      expect(filePath.split('/')).not.toContain('..');
      expect(/^[A-Za-z]:/.test(filePath)).toBe(false);
    }
    expect(new Set(allPaths).size).toBe(allPaths.length);
  });

  it('excludes recovery artifacts, temp files, dotfiles and backups from the snapshot', async () => {
    const artifacts = [
      path.join(testDataDir, 'assets', 'stray.png.bak'),
      path.join(testDataDir, 'assets', 'stray-2.png.tmp'),
      path.join(testDataDir, 'assets', '.gitkeep'),
      path.join(testDataDir, 'documents', 'doc_backup_base', '.env'),
      path.join(testDataDir, 'documents', 'doc_backup_base', 'notes.txt.tmp'),
      path.join(testDataDir, 'revisions', 'doc_backup_base', 'rev_orphan.md.tmp'),
    ];
    for (const artifact of artifacts) {
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(artifact, 'EXCLUDED-ARTIFACT', 'utf-8');
    }

    try {
      const result = await backupService.createBackupSnapshot();
      const paths = result.manifest.files.map(file => file.path);
      for (const excluded of [
        'assets/stray.png.bak',
        'assets/stray-2.png.tmp',
        'assets/.gitkeep',
        'documents/doc_backup_base/.env',
        'documents/doc_backup_base/notes.txt.tmp',
        'revisions/doc_backup_base/rev_orphan.md.tmp',
      ]) {
        expect(paths).not.toContain(excluded);
        expect(fs.existsSync(path.join(result.directory, ...excluded.split('/')))).toBe(false);
      }
    } finally {
      for (const artifact of artifacts) fs.rmSync(artifact, { force: true });
    }
  });

  it('does not follow symlinks out of the storage root', async () => {
    const outsideDir = path.join(
      os.tmpdir(),
      `inkflow_backup_outside_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
    );
    fs.mkdirSync(outsideDir, { recursive: true });
    const secretPath = path.join(outsideDir, 'outside-secret.txt');
    fs.writeFileSync(secretPath, 'MUST-NOT-BE-BACKED-UP', 'utf-8');

    const linkPath = path.join(testDataDir, 'assets', 'symlink-outside');
    let linked = false;
    try {
      try {
        await fsPromises.symlink(outsideDir, linkPath, 'dir');
        linked = true;
      } catch (err: any) {
        if (process.platform === 'win32') {
          // Junctions work without the symlink privilege on Windows.
          await fsPromises.symlink(outsideDir, linkPath, 'junction');
          linked = true;
        } else {
          throw err;
        }
      }
    } catch (err) {
      console.warn('[InkFlow Backup test] symlink unavailable, skipping escape assertion:', err);
    }

    try {
      if (!linked) return;
      const result = await backupService.createBackupSnapshot();
      expect(
        result.manifest.files.some(file => file.path.startsWith('assets/symlink-outside'))
      ).toBe(false);
      expect(
        fs.existsSync(path.join(result.directory, 'assets', 'symlink-outside', 'outside-secret.txt'))
      ).toBe(false);

      const allFiles = fs
        .readdirSync(result.directory, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => path.join(entry.parentPath ?? (entry as any).path, entry.name));
      for (const file of allFiles) {
        expect(fs.readFileSync(file).includes(Buffer.from('MUST-NOT-BE-BACKED-UP'))).toBe(false);
      }
    } finally {
      await fsPromises.rm(linkPath, { recursive: true, force: true }).catch(() => {});
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('falls back to copy when hardlinks are unsupported, and reports mixed mode', async () => {
    const allCopies = await backupService.createBackupSnapshot({
      linkFile: async () => {
        const err: any = new Error('simulated EXDEV');
        err.code = 'EXDEV';
        throw err;
      },
    });
    expect(allCopies.manifest.snapshotMode).toBe('copy');
    expect(
      fs.readFileSync(
        path.join(allCopies.directory, 'documents', 'doc_backup_base', 'index.md'),
        'utf-8'
      )
    ).toContain('第二版正文');

    const mixed = await backupService.createBackupSnapshot({
      linkFile: async (source, destination) => {
        if (source.endsWith(path.join('doc_backup_base', 'index.md'))) {
          const err: any = new Error('simulated EPERM');
          err.code = 'EPERM';
          throw err;
        }
        await fsPromises.link(source, destination);
      },
    });
    expect(mixed.manifest.snapshotMode).toBe('mixed');
  });

  it('cleans staging and leaves source data untouched when the SQLite backup fails', async () => {
    const before = finalBackupNames().length;
    const sourceMarkdown = fs.readFileSync(
      path.join(testDataDir, 'documents', 'doc_backup_base', 'index.md'),
      'utf-8'
    );

    const error = await expectRejectedBackup(
      backupService.createBackupSnapshot({
        backupDatabase: async () => {
          throw new Error('simulated sqlite backup failure');
        },
      }),
      'BACKUP_DATABASE_SNAPSHOT_FAILED'
    );
    expect(error.message).toContain('simulated sqlite backup failure');

    expect(finalBackupNames().length).toBe(before);
    expect(stagingNames()).toEqual([]);
    expect(
      fs.readFileSync(path.join(testDataDir, 'documents', 'doc_backup_base', 'index.md'), 'utf-8')
    ).toBe(sourceMarkdown);
    expect(tableCount(db, 'documents')).toBeGreaterThan(0);
  });

  it('cleans staging and leaves source data untouched when a file snapshot fails', async () => {
    const before = finalBackupNames().length;
    const sourceMarkdown = fs.readFileSync(
      path.join(testDataDir, 'documents', 'doc_backup_base', 'index.md'),
      'utf-8'
    );

    await expectRejectedBackup(
      backupService.createBackupSnapshot({
        forceCopy: true,
        copyFile: async () => {
          throw new Error('simulated copy failure');
        },
      }),
      'BACKUP_FILE_SNAPSHOT_FAILED'
    );

    expect(finalBackupNames().length).toBe(before);
    expect(stagingNames()).toEqual([]);
    expect(
      fs.readFileSync(path.join(testDataDir, 'documents', 'doc_backup_base', 'index.md'), 'utf-8')
    ).toBe(sourceMarkdown);
  });

  it('refuses to create a backup while pending recovery cannot complete', async () => {
    const docId = 'doc_backup_bad_marker';
    await saveDoc(docId, '# 待恢复\n\n原始内容不能被删除');
    const markerPath = path.join(testDataDir, 'documents', docId, '.delete.pending');
    fs.writeFileSync(markerPath, 'NOT-VALID-JSON', 'utf-8');

    const before = finalBackupNames().length;
    const originalMarkdown = fs.readFileSync(
      path.join(testDataDir, 'documents', docId, 'index.md'),
      'utf-8'
    );

    try {
      const error = await expectRejectedBackup(
        backupService.createBackupSnapshot(),
        'BACKUP_RECOVERY_FAILED'
      );
      expect(error.details?.pendingDeletions).toContain(docId);
      expect(finalBackupNames().length).toBe(before);
      expect(stagingNames()).toEqual([]);
      expect(
        fs.readFileSync(path.join(testDataDir, 'documents', docId, 'index.md'), 'utf-8')
      ).toBe(originalMarkdown);
      expect(fs.existsSync(markerPath)).toBe(true);
    } finally {
      fs.rmSync(markerPath, { force: true });
    }
  });

  it('aborts when the database references a Markdown file missing from disk', async () => {
    const docId = 'doc_backup_missing_file';
    await saveDoc(docId, '# 缺失文件\n\n这条记录必须让备份中止');
    const indexPath = path.join(testDataDir, 'documents', docId, 'index.md');
    const parkedPath = path.join(os.tmpdir(), `${docId}_${crypto.randomBytes(4).toString('hex')}.md`);
    const before = finalBackupNames().length;

    fs.renameSync(indexPath, parkedPath);
    try {
      const error = await expectRejectedBackup(
        backupService.createBackupSnapshot(),
        'BACKUP_INCONSISTENT_STATE'
      );
      expect(error.message).toContain('不一致');
      expect(finalBackupNames().length).toBe(before);
      expect(stagingNames()).toEqual([]);
      // The missing file must not be "repaired"/recreated by the backup.
      expect(fs.existsSync(indexPath)).toBe(false);
    } finally {
      fs.renameSync(parkedPath, indexPath);
    }
  });

  it('blocks concurrent document writes for the whole snapshot and resumes afterwards', async () => {
    const docId = 'doc_backup_gate';
    await saveDoc(docId, '# 并发测试\n\nBACKUP-SNAPSHOT-VERSION');

    let releaseLink!: () => void;
    const linkBarrier = new Promise<void>(resolve => (releaseLink = resolve));
    let signalEntered!: () => void;
    const entered = new Promise<void>(resolve => (signalEntered = resolve));
    let firstLink = true;

    const backupPromise = backupService.createBackupSnapshot({
      linkFile: async (source, destination) => {
        if (firstLink) {
          firstLink = false;
          signalEntered();
          await linkBarrier;
        }
        await fsPromises.link(source, destination);
      },
    });

    let saveResolved = false;
    let savePromise: Promise<void> | null = null;
    try {
      await entered;
      savePromise = saveDoc(docId, '# 并发测试\n\nUPDATED-DURING-BACKUP').then(() => {
        saveResolved = true;
      });

      // Wait until the save is queued on the shared lease, then prove it cannot
      // complete while the backup still owns the exclusive lease.
      for (let i = 0; i < 100 && consistencyGate.snapshot().queued === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(consistencyGate.snapshot().queued).toBeGreaterThan(0);
      expect(saveResolved).toBe(false);

      releaseLink();
      const result = await backupPromise;
      await savePromise;

      // The snapshot must contain the pre-backup content...
      expect(
        fs.readFileSync(path.join(result.directory, 'documents', docId, 'index.md'), 'utf-8')
      ).toContain('BACKUP-SNAPSHOT-VERSION');
      expect(
        fs.readFileSync(path.join(result.directory, 'documents', docId, 'index.md'), 'utf-8')
      ).not.toContain('UPDATED-DURING-BACKUP');
      // ...while the source has the post-backup content, proving writes resumed.
      expect(
        fs.readFileSync(path.join(testDataDir, 'documents', docId, 'index.md'), 'utf-8')
      ).toContain('UPDATED-DURING-BACKUP');
    } finally {
      releaseLink();
      await backupPromise.catch(() => {});
      await savePromise?.catch(() => {});
    }
  });

  it('works when INKFLOW_DB_PATH is outside the data directory and accepts legacy backslash paths', async () => {
    // The suite's DB already lives outside INKFLOW_DATA_DIR.
    expect(path.relative(testDataDir, testDbPath).startsWith('..')).toBe(true);

    const asset = await uploadAsset('legacy-windows.png', 'LEGACY-WINDOWS-ASSET');
    const fileName = asset.storagePath.split('/')[1];
    const backslashPath = `assets\\${fileName}`;
    db.prepare('UPDATE assets SET storage_path = ? WHERE id = ?').run(backslashPath, asset.id);
    try {
      const result = await backupService.createBackupSnapshot();
      const entry = result.manifest.files.find(file => file.path === `assets/${fileName}`);
      expect(entry).toBeTruthy();
      expect(
        fs.readFileSync(path.join(result.directory, 'assets', fileName), 'utf-8')
      ).toBe('LEGACY-WINDOWS-ASSET');
      expect(result.manifest.database.path).toBe('database/knowledge_hub.sqlite');
      const snapshot = openSnapshotDb(result.directory, result.manifest);
      try {
        expect(
          (snapshot.prepare('SELECT storage_path FROM assets WHERE id = ?').get(asset.id) as any)
            .storage_path
        ).toBe(backslashPath);
      } finally {
        snapshot.close();
      }
    } finally {
      db.prepare('UPDATE assets SET storage_path = ? WHERE id = ?').run(
        asset.storagePath,
        asset.id
      );
    }
  });

  it('strictly rejects unknown manifest versions, unsafe paths, duplicates and bad totals', async () => {
    const result = await backupService.createBackupSnapshot();
    const valid = result.manifest;

    expectBackupError(() => validateBackupManifest({ ...valid, formatVersion: 2 }), 'BACKUP_MANIFEST_INVALID');
    expectBackupError(() => validateBackupManifest({ ...valid, format: 'other' }), 'BACKUP_MANIFEST_INVALID');
    expectBackupError(
      () => validateBackupManifest({ ...valid, sessionsExcluded: false }),
      'BACKUP_MANIFEST_INVALID'
    );

    const traversal = JSON.parse(JSON.stringify(valid));
    traversal.files[0].path = '../escape.md';
    expectBackupError(() => validateBackupManifest(traversal), 'BACKUP_MANIFEST_INVALID');

    const absolute = JSON.parse(JSON.stringify(valid));
    absolute.files[0].path = '/etc/passwd';
    expectBackupError(() => validateBackupManifest(absolute), 'BACKUP_MANIFEST_INVALID');

    const duplicate = JSON.parse(JSON.stringify(valid));
    duplicate.files.push({ ...duplicate.files[0] });
    duplicate.fileCount = duplicate.files.length;
    duplicate.totalSize += duplicate.files[0].size;
    expectBackupError(() => validateBackupManifest(duplicate), 'BACKUP_MANIFEST_INVALID');

    const badCount = JSON.parse(JSON.stringify(valid));
    badCount.fileCount += 1;
    expectBackupError(() => validateBackupManifest(badCount), 'BACKUP_MANIFEST_INVALID');

    const badTotal = JSON.parse(JSON.stringify(valid));
    badTotal.totalSize += 1;
    expectBackupError(() => validateBackupManifest(badTotal), 'BACKUP_MANIFEST_INVALID');

    const badDate = JSON.parse(JSON.stringify(valid));
    badDate.createdAt = 'not-a-date';
    expectBackupError(() => validateBackupManifest(badDate), 'BACKUP_MANIFEST_INVALID');
  });
});
