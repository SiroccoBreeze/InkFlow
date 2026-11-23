import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { authService } from '../services/authService';
import { documentService } from '../services/documentService';
import { assetService } from '../services/assetService';
import { getDatabase, closeDatabase } from '../db/sqlite';
import { backupService } from '../services/backup/backupService';
import { sha256File } from '../services/backup/backupSnapshot';
import {
  assertStagingSnapshotValid,
  verifyBackupDirectory,
  verifyBackupSnapshot,
} from '../services/backup/backupVerifier';
import {
  cleanupManagedOrphanFiles,
  scanManagedOrphans,
} from '../services/backup/orphanScanner';
import type { BackupManifest } from '../services/backup/types';

const testDbPath = path.join(
  os.tmpdir(),
  `inkflow_verify_db_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.sqlite`
);
const testDataDir = path.join(
  os.tmpdir(),
  `inkflow_verify_data_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
);
const INIT_KEY = 'verify-infra-init-key-0123456789abcdef';
process.env.INKFLOW_DB_PATH = testDbPath;
process.env.INKFLOW_DATA_DIR = testDataDir;
process.env.INKFLOW_INIT_KEY = INIT_KEY;

let db: any;
let ownerId: string;
let assetId: string;

function backupsRoot(): string {
  return path.join(testDataDir, 'backups');
}

function stagingRoot(): string {
  return path.join(backupsRoot(), '.staging');
}

function publishedNames(): string[] {
  if (!fs.existsSync(backupsRoot())) return [];
  return fs
    .readdirSync(backupsRoot(), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('backup-'))
    .map(entry => entry.name)
    .sort();
}

function stagingNames(): string[] {
  if (!fs.existsSync(stagingRoot())) return [];
  return fs.readdirSync(stagingRoot()).sort();
}

function snapshotDatabasePath(directory: string): string {
  return path.join(directory, 'database', 'knowledge_hub.sqlite');
}

function readManifest(directory: string): BackupManifest {
  return JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf-8')) as BackupManifest;
}

function writeManifest(directory: string, manifest: BackupManifest): void {
  manifest.fileCount = manifest.files.length;
  manifest.totalSize = manifest.files.reduce((sum, file) => sum + file.size, 0);
  fs.writeFileSync(
    path.join(directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8'
  );
}

async function refreshManifestFile(
  directory: string,
  manifest: BackupManifest,
  relativePath: string
): Promise<void> {
  const entry = manifest.files.find(file => file.path === relativePath);
  if (!entry) throw new Error(`manifest entry not found: ${relativePath}`);
  const absolutePath = path.join(directory, ...relativePath.split('/'));
  const stat = fs.statSync(absolutePath);
  entry.size = stat.size;
  entry.sha256 = await sha256File(absolutePath);
  writeManifest(directory, manifest);
}

async function refreshManifestDatabase(directory: string, manifest: BackupManifest): Promise<void> {
  const absolutePath = path.join(directory, ...manifest.database.path.split('/'));
  const stat = fs.statSync(absolutePath);
  manifest.database.size = stat.size;
  manifest.database.sha256 = await sha256File(absolutePath);
  writeManifest(directory, manifest);
}

function treeFingerprint(directory: string): Record<string, { size: number; mtimeMs: number }> {
  const output: Record<string, { size: number; mtimeMs: number }> = {};
  const walk = (absoluteDir: string, relativeDir: string) => {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolutePath = path.join(absoluteDir, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isDirectory()) {
        output[`${relativePath}/`] = { size: 0, mtimeMs: stat.mtimeMs };
        walk(absolutePath, relativePath);
      } else {
        output[relativePath] = { size: stat.size, mtimeMs: stat.mtimeMs };
      }
    }
  };
  walk(directory, '');
  return output;
}

async function saveDoc(
  docId: string,
  body: string,
  opts: { visibility?: 'public' | 'private' | 'unlisted'; status?: 'draft' | 'published' | 'archived' } = {}
): Promise<void> {
  await documentService.saveDocument(
    {
      id: docId,
      title: `Verify doc ${docId}`,
      slug: docId,
      rawMarkdown: body,
      category: '安全与数据主权',
      tags: ['验证测试'],
      visibility: opts.visibility ?? 'public',
      status: opts.status ?? 'published',
    },
    ownerId
  );
}

async function uploadAsset(filename: string, content = 'verify-asset-bytes'): Promise<any> {
  return assetService.uploadAsset({
    originalName: filename,
    mimeType: 'image/png',
    buffer: Buffer.from(content, 'utf-8'),
    ownerId,
  });
}

async function createBackup(options: Parameters<typeof backupService.createBackupSnapshot>[0] = {}) {
  return backupService.createBackupSnapshot(options);
}

function codes(report: { issues: Array<{ code: string }> }): string[] {
  return report.issues.map(issue => issue.code);
}

describe('V1.2 Batch 2B-1 independent backup verifier', () => {
  beforeAll(async () => {
    closeDatabase();
    db = getDatabase();
    const init = authService.initializeOwner({
      initKey: INIT_KEY,
      username: 'verify_owner',
      password: 'VerifyOwnerPassword!',
      email: 'verify@inkflow.local',
    });
    expect(init.success).toBe(true);
    ownerId = init.user.id;

    const asset = await uploadAsset('verify-asset.png', 'VERIFY-ASSET-CONTENT');
    assetId = asset.id;

    await saveDoc(
      'doc_verify_base',
      `# 验证文档\n\n![图](/api/v1/assets/file/${assetId})\n\nVERIFY-MARKER 第一版。`
    );
    // Second save creates a revision snapshot of the first version.
    await saveDoc(
      'doc_verify_base',
      `# 验证文档\n\n![图](/api/v1/assets/file/${assetId})\n\nVERIFY-MARKER 第二版。`
    );
  });

  afterAll(() => {
    closeDatabase();
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        const candidate = `${testDbPath}${suffix}`;
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
      }
      if (fs.existsSync(testDataDir)) {
        fs.rmSync(testDataDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  it('verifies a valid published backup and reports its real counts', async () => {
    const result = await createBackup();
    const report = await verifyBackupSnapshot(result.id);

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.readOnly).toBe(true);
    expect(report.restorableWithThisBuild).toBe(true);
    expect(report.counts.documents).toBeGreaterThan(0);
    expect(report.counts.revisions).toBeGreaterThan(0);
    expect(report.counts.assets).toBeGreaterThan(0);
    expect(report.counts.files).toBe(result.manifest.fileCount);
    expect(report.snapshotMode).toBe('copy');
    expect(report.warnings.filter(warning => warning.code !== 'PLATFORM_NO_NOFOLLOW')).toEqual([]);
    expect(report.checks.every(check => check.ok)).toBe(true);
  });

  it('never modifies the backup, manifest or database while verifying', async () => {
    const result = await createBackup();
    const before = treeFingerprint(result.directory);
    const databaseBefore = await sha256File(snapshotDatabasePath(result.directory));

    const report = await verifyBackupSnapshot(result.id);

    expect(report.ok).toBe(true);
    expect(treeFingerprint(result.directory)).toEqual(before);
    expect(await sha256File(snapshotDatabasePath(result.directory))).toBe(databaseBefore);
    expect(fs.readdirSync(path.join(result.directory, 'database'))).toEqual([
      'knowledge_hub.sqlite',
    ]);
  });

  it('runs the same core against a staging directory and aborts on tampering', async () => {
    const result = await createBackup();
    const stagingId = 'backup-20000101T000000000Z-aaaaaaaa';
    const stagingDirectory = path.join(stagingRoot(), stagingId);
    fs.cpSync(result.directory, stagingDirectory, { recursive: true });

    try {
      const report = await verifyBackupDirectory(stagingDirectory, {
        kind: 'staging',
        expectedId: stagingId,
      });
      expect(report.ok).toBe(true);
      expect(report.kind).toBe('staging');

      fs.appendFileSync(
        path.join(stagingDirectory, 'documents', 'doc_verify_base', 'index.md'),
        'TAMPERED'
      );
      const tampered = await verifyBackupDirectory(stagingDirectory, {
        kind: 'staging',
        expectedId: stagingId,
      });
      expect(tampered.ok).toBe(false);
      expect(codes(tampered)).toContain('HASH_MISMATCH');

      await expect(assertStagingSnapshotValid(stagingDirectory, stagingId)).rejects.toMatchObject({
        code: 'BACKUP_VERIFICATION_FAILED',
      });
    } finally {
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
    }
  });

  it('re-reads the manifest and re-hashes the staged tree before publication', async () => {
    const before = publishedNames().length;

    await expect(
      createBackup({
        beforePublishVerification: async stagingDir => {
          fs.appendFileSync(
            path.join(stagingDir, 'documents', 'doc_verify_base', 'index.md'),
            'MUTATED-AFTER-MANIFEST'
          );
        },
      })
    ).rejects.toMatchObject({ code: 'BACKUP_VERIFICATION_FAILED' });

    expect(publishedNames().length).toBe(before);
    expect(stagingNames()).toEqual([]);
  });

  it('rejects a manifest that was changed after being written', async () => {
    await expect(
      createBackup({
        beforePublishVerification: async stagingDir => {
          const manifest = readManifest(stagingDir);
          manifest.files[0].sha256 = '0'.repeat(64);
          writeManifest(stagingDir, manifest);
        },
      })
    ).rejects.toMatchObject({ code: 'BACKUP_VERIFICATION_FAILED' });
  });

  it('detects a same-size file tampering in a published backup', async () => {
    const result = await createBackup();
    const target = path.join(result.directory, 'documents', 'doc_verify_base', 'index.md');
    const original = fs.readFileSync(target, 'utf-8');
    fs.writeFileSync(target, original.replace('第二版', '篡改版'), 'utf-8');

    const report = await verifyBackupSnapshot(result.id);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('HASH_MISMATCH');
    expect(report.issues.some(issue => issue.path === 'documents/doc_verify_base/index.md')).toBe(true);
  });

  it('detects missing, unknown, hidden and non-regular entries', async () => {
    const result = await createBackup();

    fs.writeFileSync(path.join(result.directory, 'documents', 'doc_verify_base', 'extra.txt'), 'x');
    fs.writeFileSync(path.join(result.directory, '.hidden'), 'x');
    fs.mkdirSync(path.join(result.directory, 'assets', 'nested'), { recursive: true });

    const report = await verifyBackupSnapshot(result.id);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('EXTRA_FILE');
    expect(codes(report)).toContain('HIDDEN_FILE');
    expect(codes(report)).toContain('EXTRA_DIRECTORY');
  });

  it('rejects symlinks and FIFOs inside a backup', async () => {
    const result = await createBackup();
    let linked = false;
    try {
      fs.symlinkSync(
        path.join(result.directory, 'manifest.json'),
        path.join(result.directory, 'manifest-link')
      );
      linked = true;
    } catch {
      // Windows without symlink privileges: skip the symlink assertion.
    }

    let fifo = false;
    if (process.platform !== 'win32') {
      try {
        execFileSync('mkfifo', [path.join(result.directory, 'a-fifo')]);
        fifo = true;
      } catch {
        // mkfifo unavailable in this environment.
      }
    }

    const report = await verifyBackupSnapshot(result.id);
    expect(report.ok).toBe(false);
    if (linked) expect(codes(report)).toContain('SYMLINK_PRESENT');
    if (fifo) expect(codes(report)).toContain('NON_REGULAR_ENTRY');
  });

  it('detects database corruption, sidecars and sessions that were not excluded', async () => {
    const corrupted = await createBackup();
    const databasePath = snapshotDatabasePath(corrupted.directory);
    const bytes = fs.readFileSync(databasePath);
    bytes[200] = bytes[200] ^ 0xff;
    fs.writeFileSync(databasePath, bytes);
    const corruptionReport = await verifyBackupSnapshot(corrupted.id);
    expect(corruptionReport.ok).toBe(false);
    expect(codes(corruptionReport)).toContain('DATABASE_HASH_MISMATCH');

    const withSidecar = await createBackup();
    fs.writeFileSync(
      path.join(withSidecar.directory, 'database', 'knowledge_hub.sqlite-wal'),
      'not-a-wal'
    );
    const sidecarReport = await verifyBackupSnapshot(withSidecar.id);
    expect(codes(sidecarReport)).toContain('DATABASE_SIDECAR_PRESENT');

    const withSession = await createBackup();
    const sessionDb = new DatabaseSync(snapshotDatabasePath(withSession.directory));
    try {
      sessionDb.exec('PRAGMA journal_mode = DELETE;');
      sessionDb
        .prepare(
          `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          'sess_verify_tamper',
          ownerId,
          crypto.randomBytes(32).toString('hex'),
          new Date(Date.now() + 3600_000).toISOString(),
          new Date().toISOString(),
          new Date().toISOString()
        );
    } finally {
      sessionDb.close();
    }
    await refreshManifestDatabase(withSession.directory, readManifest(withSession.directory));
    const sessionReport = await verifyBackupSnapshot(withSession.id);
    expect(sessionReport.ok).toBe(false);
    expect(codes(sessionReport)).toContain('SESSIONS_NOT_EXCLUDED');
  });

  it('detects foreign-key violations and dangling asset associations', async () => {
    const result = await createBackup();
    const database = new DatabaseSync(snapshotDatabasePath(result.directory));
    try {
      database.exec('PRAGMA foreign_keys = OFF;');
      database
        .prepare('INSERT INTO document_assets (document_id, asset_id, created_at) VALUES (?, ?, ?)')
        .run('doc_verify_base', 'ast_missing_verify', new Date().toISOString());
    } finally {
      database.close();
    }
    await refreshManifestDatabase(result.directory, readManifest(result.directory));

    const report = await verifyBackupSnapshot(result.id);
    expect(report.ok).toBe(false);
    expect(
      codes(report).some(code =>
        ['FOREIGN_KEY_VIOLATION', 'DATABASE_STATE_INVALID'].includes(code)
      )
    ).toBe(true);
  });

  it('fails when Markdown references an attachment that has no database row', async () => {
    const result = await createBackup();
    const target = path.join(result.directory, 'documents', 'doc_verify_base', 'index.md');
    const original = fs.readFileSync(target, 'utf-8');
    fs.writeFileSync(
      target,
      `${original}\n\n![missing](/api/v1/assets/file/ast_missing_verify)\n`,
      'utf-8'
    );
    const manifest = readManifest(result.directory);
    await refreshManifestFile(result.directory, manifest, 'documents/doc_verify_base/index.md');

    const report = await verifyBackupSnapshot(result.id);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('ASSET_REFERENCE_MISSING');
  });

  it('checks revision and document frontmatter against the database', async () => {
    const revisionResult = await createBackup();
    const revisionEntry = revisionResult.manifest.files.find(file =>
      file.path.startsWith('revisions/doc_verify_base/')
    );
    expect(revisionEntry).toBeTruthy();
    const revisionPath = path.join(revisionResult.directory, ...revisionEntry!.path.split('/'));
    const revisionRaw = fs.readFileSync(revisionPath, 'utf-8');
    fs.writeFileSync(
      revisionPath,
      revisionRaw.replace(/^title: ".*"$/m, 'title: "TAMPERED REVISION TITLE"'),
      'utf-8'
    );
    await refreshManifestFile(
      revisionResult.directory,
      readManifest(revisionResult.directory),
      revisionEntry!.path
    );

    const revisionReport = await verifyBackupSnapshot(revisionResult.id);
    expect(revisionReport.ok).toBe(false);
    expect(codes(revisionReport)).toContain('REVISION_FRONTMATTER_TITLE_MISMATCH');

    const documentResult = await createBackup();
    const documentPath = path.join(
      documentResult.directory,
      'documents',
      'doc_verify_base',
      'index.md'
    );
    const documentRaw = fs.readFileSync(documentPath, 'utf-8');
    fs.writeFileSync(
      documentPath,
      documentRaw.replace(/^id: ".*"$/m, 'id: "doc_tampered"'),
      'utf-8'
    );
    await refreshManifestFile(
      documentResult.directory,
      readManifest(documentResult.directory),
      'documents/doc_verify_base/index.md'
    );

    const documentReport = await verifyBackupSnapshot(documentResult.id);
    expect(documentReport.ok).toBe(false);
    expect(codes(documentReport)).toContain('DOCUMENT_FRONTMATTER_ID_MISMATCH');

    const titleResult = await createBackup();
    const titlePath = path.join(
      titleResult.directory,
      'documents',
      'doc_verify_base',
      'index.md'
    );
    const titleRaw = fs.readFileSync(titlePath, 'utf-8');
    fs.writeFileSync(
      titlePath,
      titleRaw.replace(/^title: ".*"$/m, 'title: "TAMPERED DOCUMENT TITLE"'),
      'utf-8'
    );
    await refreshManifestFile(
      titleResult.directory,
      readManifest(titleResult.directory),
      'documents/doc_verify_base/index.md'
    );

    const titleReport = await verifyBackupSnapshot(titleResult.id);
    expect(titleReport.ok).toBe(false);
    expect(codes(titleReport)).toContain('DOCUMENT_FRONTMATTER_TITLE_MISMATCH');
  });

  it('blocks verification of an uncalibrated attachment instead of skipping its hash', async () => {
    const result = await createBackup();
    const database = new DatabaseSync(snapshotDatabasePath(result.directory));
    try {
      database.prepare('UPDATE assets SET checksum = ? WHERE id = ?').run('', assetId);
    } finally {
      database.close();
    }
    await refreshManifestDatabase(result.directory, readManifest(result.directory));

    const report = await verifyBackupSnapshot(result.id);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('ASSET_CHECKSUM_MISSING');
  });

  it('rejects invalid backup IDs and refuses to escape the backups root', async () => {
    await expect(verifyBackupSnapshot('../escape')).rejects.toMatchObject({
      code: 'BACKUP_VERIFICATION_TARGET_INVALID',
    });
    await expect(verifyBackupSnapshot('.staging')).rejects.toMatchObject({
      code: 'BACKUP_VERIFICATION_TARGET_INVALID',
    });
    await expect(
      verifyBackupSnapshot('backup-20000101T000000000Z-deadbeef')
    ).rejects.toMatchObject({ code: 'BACKUP_VERIFICATION_TARGET_INVALID' });
  });

  it('does not block production writes while verifying a published backup', async () => {
    const result = await createBackup();

    let release!: () => void;
    const barrier = new Promise<void>(resolve => (release = resolve));
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => (entered = resolve));

    const verificationPromise = verifyBackupSnapshot(result.id, {
      testHooks: {
        beforeHashing: async () => {
          entered();
          await barrier;
        },
      },
    });

    await enteredPromise;
    await saveDoc('doc_verify_during', '# 验证期间的写入\n\nWRITE-DURING-VERIFY');
    release();

    const report = await verificationPromise;
    expect(report.ok).toBe(true);
    expect(
      fs.readFileSync(path.join(testDataDir, 'documents', 'doc_verify_during', 'index.md'), 'utf-8')
    ).toContain('WRITE-DURING-VERIFY');
  }, 15000);

  it('defaults to an independent copy that survives in-place source edits', async () => {
    const result = await createBackup();
    expect(result.manifest.snapshotMode).toBe('copy');

    const sourcePath = path.join(testDataDir, 'documents', 'doc_verify_base', 'index.md');
    const backupPath = path.join(
      result.directory,
      'documents',
      'doc_verify_base',
      'index.md'
    );
    const original = fs.readFileSync(sourcePath, 'utf-8');
    const backupBefore = fs.readFileSync(backupPath, 'utf-8');
    const tampered = original.replace('第二版', '篡改版');
    expect(tampered.length).toBe(original.length);

    fs.writeFileSync(sourcePath, tampered, 'utf-8');
    try {
      const report = await verifyBackupSnapshot(result.id);
      expect(report.ok).toBe(true);
      expect(fs.readFileSync(backupPath, 'utf-8')).toBe(backupBefore);
    } finally {
      fs.writeFileSync(sourcePath, original, 'utf-8');
    }
  });

  it('records hardlink mode as opt-in and proves it is not an independent backup', async () => {
    const result = await createBackup({ useHardlinks: true });
    if (result.manifest.snapshotMode !== 'hardlink') {
      // Some filesystems (or Windows without hardlink permission) cannot link.
      return;
    }

    const sourcePath = path.join(testDataDir, 'documents', 'doc_verify_base', 'index.md');
    const backupPath = path.join(result.directory, 'documents', 'doc_verify_base', 'index.md');
    const original = fs.readFileSync(sourcePath, 'utf-8');
    const tampered = original.replace('第二版', '原地版');
    expect(tampered.length).toBe(original.length);

    fs.writeFileSync(sourcePath, tampered, 'utf-8');
    try {
      expect(fs.readFileSync(backupPath, 'utf-8')).toBe(tampered);
      const tamperedReport = await verifyBackupSnapshot(result.id);
      expect(tamperedReport.ok).toBe(false);
      expect(codes(tamperedReport)).toContain('HASH_MISMATCH');
      expect(tamperedReport.warnings.map(warning => warning.code)).toContain(
        'HARDLINK_SNAPSHOT_NOT_INDEPENDENT'
      );
    } finally {
      fs.writeFileSync(sourcePath, original, 'utf-8');
    }

    const restoredReport = await verifyBackupSnapshot(result.id);
    expect(restoredReport.ok).toBe(true);
    expect(restoredReport.warnings.map(warning => warning.code)).toContain(
      'HARDLINK_SNAPSHOT_NOT_INDEPENDENT'
    );
  });

  it('refuses to create a backup when a managed directory contains an unknown file', async () => {
    const unknownPath = path.join(testDataDir, 'documents', 'doc_verify_base', 'notes.txt');
    fs.writeFileSync(unknownPath, 'UNREGISTERED', 'utf-8');
    const before = publishedNames().length;
    try {
      await expect(createBackup()).rejects.toMatchObject({
        code: 'BACKUP_INCONSISTENT_STATE',
      });
      expect(publishedNames().length).toBe(before);
      expect(stagingNames()).toEqual([]);
    } finally {
      fs.rmSync(unknownPath, { force: true });
    }
  });

  it('refuses to create a backup when Markdown references a missing attachment', async () => {
    await saveDoc(
      'doc_verify_missing_ref',
      '# 缺失引用\n\n![missing](/api/v1/assets/file/ast_missing_verify)'
    );
    try {
      await expect(createBackup()).rejects.toMatchObject({
        code: 'BACKUP_INCONSISTENT_STATE',
      });
    } finally {
      await documentService.deleteDocument('doc_verify_missing_ref');
    }
  });

  it('previews and explicitly cleans orphan revision/asset files, never from the backup flow', async () => {
    const orphanAssetName = `ast_orphan_${Date.now()}_${crypto
      .randomBytes(2)
      .toString('hex')}.png`;
    const orphanRevisionName = `rev_orphan_${Date.now()}_${crypto
      .randomBytes(2)
      .toString('hex')}.md`;
    const assetPath = path.join(testDataDir, 'assets', orphanAssetName);
    const revisionPath = path.join(
      testDataDir,
      'revisions',
      'doc_verify_base',
      orphanRevisionName
    );
    const assetRelative = `assets/${orphanAssetName}`;
    const revisionRelative = `revisions/doc_verify_base/${orphanRevisionName}`;

    fs.writeFileSync(assetPath, 'ORPHAN-ASSET', 'utf-8');
    fs.mkdirSync(path.dirname(revisionPath), { recursive: true });
    fs.writeFileSync(revisionPath, '---\nid: "doc_verify_base"\n---\n\nORPHAN-REVISION', 'utf-8');

    try {
      const scan = await scanManagedOrphans();
      const paths = scan.orphans.map(orphan => orphan.relativePath);
      expect(paths).toContain(assetRelative);
      expect(paths).toContain(revisionRelative);
      expect(scan.cleanableCount).toBeGreaterThanOrEqual(2);

      // The backup flow only fails closed; it never deletes the orphans.
      await expect(createBackup()).rejects.toMatchObject({
        code: 'BACKUP_INCONSISTENT_STATE',
      });
      expect(fs.existsSync(assetPath)).toBe(true);
      expect(fs.existsSync(revisionPath)).toBe(true);

      const dryRun = await cleanupManagedOrphanFiles({
        relativePaths: [assetRelative, revisionRelative],
        dryRun: true,
      });
      expect(dryRun.wouldRemove.sort()).toEqual([assetRelative, revisionRelative].sort());
      expect(fs.existsSync(assetPath)).toBe(true);
      expect(fs.existsSync(revisionPath)).toBe(true);

      const cleaned = await cleanupManagedOrphanFiles({
        relativePaths: [assetRelative, revisionRelative],
      });
      expect(cleaned.removed.sort()).toEqual([assetRelative, revisionRelative].sort());
      expect(fs.existsSync(assetPath)).toBe(false);
      expect(fs.existsSync(revisionPath)).toBe(false);

      const result = await createBackup();
      expect((await verifyBackupSnapshot(result.id)).ok).toBe(true);
    } finally {
      fs.rmSync(assetPath, { force: true });
      fs.rmSync(revisionPath, { force: true });
    }
  });

  it('never auto-cleans unregistered files inside a document folder', async () => {
    const extraPath = path.join(testDataDir, 'documents', 'doc_verify_base', 'notes.txt');
    fs.writeFileSync(extraPath, 'USER-NOTES', 'utf-8');
    try {
      const scan = await scanManagedOrphans();
      const entry = scan.orphans.find(
        orphan => orphan.relativePath === 'documents/doc_verify_base/notes.txt'
      );
      expect(entry).toBeTruthy();
      expect(entry!.cleanable).toBe(false);

      const result = await cleanupManagedOrphanFiles({
        relativePaths: ['documents/doc_verify_base/notes.txt'],
      });
      expect(result.removed).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(fs.existsSync(extraPath)).toBe(true);
    } finally {
      fs.rmSync(extraPath, { force: true });
    }
  });

  it('does not clean an asset file that still has a deletion tombstone', async () => {
    const fileName = `ast_tomb_${Date.now()}.png`;
    const assetId = fileName.replace(/\.png$/, '');
    const relativePath = `assets/${fileName}`;
    const absolutePath = path.join(testDataDir, 'assets', fileName);
    fs.writeFileSync(absolutePath, 'TOMBSTONED', 'utf-8');
    db.prepare(
      `INSERT OR REPLACE INTO asset_deletions
       (asset_id, storage_path, filename, reason, requested_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(assetId, relativePath, fileName, 'manual-delete', new Date().toISOString());

    try {
      const scan = await scanManagedOrphans();
      const entry = scan.orphans.find(orphan => orphan.relativePath === relativePath);
      expect(entry).toBeTruthy();
      expect(entry!.cleanable).toBe(false);

      const result = await cleanupManagedOrphanFiles({ relativePaths: [relativePath] });
      expect(result.removed).toEqual([]);
      expect(fs.existsSync(absolutePath)).toBe(true);
    } finally {
      db.prepare('DELETE FROM asset_deletions WHERE asset_id = ?').run(assetId);
      fs.rmSync(absolutePath, { force: true });
    }
  });

  it('aborts when a source is swapped to a symlink after the pre-check', async () => {
    const documentPath = path.join(testDataDir, 'documents', 'doc_verify_base', 'index.md');
    const original = fs.readFileSync(documentPath, 'utf-8');
    const outsidePath = path.join(
      os.tmpdir(),
      `inkflow_verify_outside_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.md`
    );
    fs.writeFileSync(outsidePath, original, 'utf-8');

    const probePath = path.join(testDataDir, 'symlink-probe');
    try {
      fs.symlinkSync(outsidePath, probePath);
      fs.rmSync(probePath, { force: true });
    } catch {
      // Windows without symlink privileges: this race cannot be simulated here.
      fs.rmSync(outsidePath, { force: true });
      return;
    }

    const before = publishedNames().length;
    let swapped = false;
    try {
      await expect(
        createBackup({
          beforeSourceOpen: async (relativePath, absolutePath) => {
            if (relativePath !== 'documents/doc_verify_base/index.md' || swapped) return;
            swapped = true;
            fs.rmSync(absolutePath, { force: true });
            fs.symlinkSync(outsidePath, absolutePath);
          },
        })
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^BACKUP_(INCONSISTENT_STATE|FILE_SNAPSHOT_FAILED)$/),
      });

      expect(swapped).toBe(true);
      expect(publishedNames().length).toBe(before);
      expect(stagingNames()).toEqual([]);
    } finally {
      fs.rmSync(documentPath, { force: true });
      fs.writeFileSync(documentPath, original, 'utf-8');
      fs.rmSync(outsidePath, { force: true });
    }
  });

  it('aborts when a source changes while it is being copied', async () => {
    const documentPath = path.join(testDataDir, 'documents', 'doc_verify_base', 'index.md');
    const original = fs.readFileSync(documentPath, 'utf-8');
    const tampered = original.replace('第二版', '篡改版');
    expect(tampered.length).toBe(original.length);

    let mutated = false;
    const before = publishedNames().length;
    try {
      await expect(
        createBackup({
          afterSourceCopyChunk: async (relativePath, bytesReadTotal) => {
            if (
              relativePath !== 'documents/doc_verify_base/index.md' ||
              mutated ||
              bytesReadTotal <= 0
            ) {
              return;
            }
            mutated = true;
            fs.writeFileSync(documentPath, tampered, 'utf-8');
          },
        })
      ).rejects.toMatchObject({ code: 'BACKUP_INCONSISTENT_STATE' });

      expect(mutated).toBe(true);
      expect(publishedNames().length).toBe(before);
      expect(stagingNames()).toEqual([]);
    } finally {
      fs.writeFileSync(documentPath, original, 'utf-8');
    }
  });

  it('computes the hash and parses frontmatter from the same document bytes', async () => {
    const result = await createBackup();
    const backupDocumentPath = path.join(
      result.directory,
      'documents',
      'doc_verify_base',
      'index.md'
    );
    const original = fs.readFileSync(backupDocumentPath, 'utf-8');
    const tampered = original.replace('第二版', '篡改版');
    let replaced = false;

    try {
      const report = await verifyBackupSnapshot(result.id, {
        testHooks: {
          afterFileRead: async relativePath => {
            if (relativePath !== 'documents/doc_verify_base/index.md' || replaced) return;
            replaced = true;
            // Replace the on-disk file AFTER its bytes were read+hashed. The
            // verifier must parse the buffer it already hashed, so this must not
            // turn into a semantic mismatch for different bytes.
            fs.writeFileSync(backupDocumentPath, tampered, 'utf-8');
          },
        },
      });

      expect(replaced).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.issues).toEqual([]);
    } finally {
      fs.writeFileSync(backupDocumentPath, original, 'utf-8');
    }
  });

  it('fails when a document or revision frontmatter title is missing', async () => {
    const documentResult = await createBackup();
    const documentPath = path.join(
      documentResult.directory,
      'documents',
      'doc_verify_base',
      'index.md'
    );
    const documentRaw = fs.readFileSync(documentPath, 'utf-8');
    fs.writeFileSync(documentPath, documentRaw.replace(/^title: .*\n/m, ''), 'utf-8');
    await refreshManifestFile(
      documentResult.directory,
      readManifest(documentResult.directory),
      'documents/doc_verify_base/index.md'
    );

    const documentReport = await verifyBackupSnapshot(documentResult.id);
    expect(documentReport.ok).toBe(false);
    expect(codes(documentReport)).toContain('DOCUMENT_FRONTMATTER_TITLE_MISSING');

    const revisionResult = await createBackup();
    const revisionEntry = revisionResult.manifest.files.find(file =>
      file.path.startsWith('revisions/doc_verify_base/')
    );
    expect(revisionEntry).toBeTruthy();
    const revisionPath = path.join(revisionResult.directory, ...revisionEntry!.path.split('/'));
    const revisionRaw = fs.readFileSync(revisionPath, 'utf-8');
    fs.writeFileSync(revisionPath, revisionRaw.replace(/^title: .*\n/m, ''), 'utf-8');
    await refreshManifestFile(
      revisionResult.directory,
      readManifest(revisionResult.directory),
      revisionEntry!.path
    );

    const revisionReport = await verifyBackupSnapshot(revisionResult.id);
    expect(revisionReport.ok).toBe(false);
    expect(codes(revisionReport)).toContain('REVISION_FRONTMATTER_TITLE_MISSING');
  });

  it('rejects a VIEW masquerading as a core data table', async () => {
    const result = await createBackup();
    const database = new DatabaseSync(snapshotDatabasePath(result.directory));
    try {
      database.exec('PRAGMA foreign_keys = OFF;');
      database.exec('DROP TABLE sessions;');
      database.exec(`
        CREATE VIEW sessions AS
        SELECT '' AS id, '' AS user_id, '' AS token_hash, '' AS expires_at,
               '' AS created_at, '' AS last_seen_at
        WHERE 0;
      `);
    } finally {
      database.close();
    }
    await refreshManifestDatabase(result.directory, readManifest(result.directory));

    const report = await verifyBackupSnapshot(result.id);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('REQUIRED_TABLE_NOT_REAL');
    expect(report.checks.find(check => check.name === 'databaseState')?.ok).toBe(false);
  });

  it('rejects an ordinary table masquerading as documents_fts', async () => {
    const result = await createBackup();
    const database = new DatabaseSync(snapshotDatabasePath(result.directory));
    try {
      database.exec('DROP TABLE documents_fts;');
      database.exec('CREATE TABLE documents_fts (document_id TEXT, body TEXT);');
    } finally {
      database.close();
    }
    await refreshManifestDatabase(result.directory, readManifest(result.directory));

    const report = await verifyBackupSnapshot(result.id);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('FTS_TABLE_INVALID');
  });

  it('reports incomplete migration audit rows as a warning', async () => {
    const result = await createBackup();
    const database = new DatabaseSync(snapshotDatabasePath(result.directory));
    try {
      database.prepare('DELETE FROM schema_migrations WHERE version = ?').run(3);
    } finally {
      database.close();
    }
    await refreshManifestDatabase(result.directory, readManifest(result.directory));

    const report = await verifyBackupSnapshot(result.id);
    const warningCodes = report.warnings.map(warning => warning.code);
    expect(
      warningCodes.some(code =>
        ['SCHEMA_MIGRATION_AUDIT_INCOMPLETE', 'SCHEMA_MIGRATION_AUDIT_GAPS'].includes(code)
      )
    ).toBe(true);
    expect(report.checks.find(check => check.name === 'migrationAudit')?.ok).toBe(false);
  });

  it('rejects a migration audit row newer than user_version', async () => {
    const result = await createBackup();
    const database = new DatabaseSync(snapshotDatabasePath(result.directory));
    try {
      database
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(99, 'tampered-future-migration', new Date().toISOString());
    } finally {
      database.close();
    }
    await refreshManifestDatabase(result.directory, readManifest(result.directory));

    const report = await verifyBackupSnapshot(result.id);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('SCHEMA_MIGRATION_AUDIT_AHEAD');
  });
});
