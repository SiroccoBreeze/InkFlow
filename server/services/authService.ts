import crypto from 'node:crypto';
import { getDatabase, hashPassword, verifyPassword, hashRecoveryCode, generateId, seedDefaultCategoriesIfEmpty } from '../db/sqlite';

const MIN_INIT_KEY_LENGTH = 24;
const OWNER_INITIALIZED_MARKER = 'owner_initialized';

function getInitializationKey(): string {
  return (process.env.INKFLOW_INIT_KEY || '').trim();
}

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

export class AuthService {
  private getDb() {
    return getDatabase();
  }

  /**
   * Generates a cryptographically strong, human-readable one-time recovery key.
   * Format: INK-XXXX-XXXX-XXXX-XXXX
   */
  public generateRecoveryCode(): string {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const parts: string[] = [];
    for (let p = 0; p < 4; p++) {
      let segment = '';
      const bytes = crypto.randomBytes(4);
      for (let i = 0; i < 4; i++) {
        segment += chars[bytes[i] % chars.length];
      }
      parts.push(segment);
    }
    return `INK-${parts.join('-')}`;
  }

  /**
   * Whether a one-time initialization key is configured via environment.
   * The key is never hardcoded and never shipped to the frontend.
   */
  public isInitializationKeyConfigured(): boolean {
    return getInitializationKey().length >= MIN_INIT_KEY_LENGTH;
  }

  /**
   * Checks whether an active owner has been initialized.
   */
  public isInitialized(): boolean {
    const db = this.getDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ? AND is_active = 1').get('owner') as any;
    if ((row?.count || 0) > 0) return true;
    // One-way marker: once set, initialization stays closed even if the owner row is later disabled.
    try {
      const marker = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(OWNER_INITIALIZED_MARKER) as any;
      if (marker?.value === '1') return true;
    } catch {
      // pre-migration database without system_settings table
    }
    return false;
  }

  /**
   * Whether the system can currently accept a first-run initialization.
   */
  public canInitialize(): boolean {
    return this.isInitializationKeyConfigured() && !this.isInitialized();
  }

  /**
   * Constant-time verification of the one-time initialization key.
   */
  public verifyInitializationKey(candidate: unknown): boolean {
    const expected = getInitializationKey();
    if (!expected || expected.length < MIN_INIT_KEY_LENGTH) return false;
    if (typeof candidate !== 'string' || !candidate) return false;
    const actualDigest = sha256(candidate);
    const expectedDigest = sha256(expected);
    return crypto.timingSafeEqual(actualDigest, expectedDigest);
  }

  private markOwnerInitialized(db: ReturnType<AuthService['getDb']>): void {
    db.prepare(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES (?, '1', ?)
      ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at
    `).run(OWNER_INITIALIZED_MARKER, new Date().toISOString());
  }

  /**
   * First-run admin initialization. Requires the one-time initialization key and
   * can only be invoked when the system is uninitialized.
   */
  public initializeOwner(params: {
    initKey?: string;
    username?: string;
    password: string;
    email?: string;
  }): { success: boolean; user?: any; token?: string; recoveryCode?: string; message?: string; code?: string } {
    const { initKey, username = 'owner', password, email } = params;

    if (!this.isInitializationKeyConfigured()) {
      return {
        success: false,
        code: 'INIT_KEY_NOT_CONFIGURED',
        message: '服务端尚未配置初始化密钥（INKFLOW_INIT_KEY），无法执行首次初始化',
      };
    }

    if (!this.verifyInitializationKey(initKey)) {
      return { success: false, code: 'INVALID_INIT_KEY', message: '初始化密钥无效' };
    }

    if (!password || password.length < 6) {
      return { success: false, code: 'INVALID_PASSWORD', message: '主理人访问密钥最低要求 6 位' };
    }

    const db = this.getDb();
    db.exec('BEGIN IMMEDIATE;');

    try {
      // 1. Strict atomic check inside transaction
      const existing = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('owner') as any;
      if ((existing?.count || 0) > 0) {
        db.exec('ROLLBACK;');
        return { success: false, code: 'ALREADY_INITIALIZED', message: '系统主理人账号已初始化，无法重复执行' };
      }
      const marker = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(OWNER_INITIALIZED_MARKER) as any;
      if (marker?.value === '1') {
        db.exec('ROLLBACK;');
        return { success: false, code: 'ALREADY_INITIALIZED', message: '系统已完成初始化，初始化入口已永久关闭' };
      }

      const userId = generateId('usr_owner');
      const now = new Date().toISOString();
      const passwordHash = hashPassword(password);
      const recoveryCode = this.generateRecoveryCode();
      const recoveryHash = hashRecoveryCode(recoveryCode);
      const recoveryId = generateId('rec');

      // 2. Insert Owner user
      db.prepare(`
        INSERT INTO users (id, username, email, password_hash, role, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'owner', 1, ?, ?)
      `).run(userId, username.trim(), email ? email.trim() : null, passwordHash, now, now);

      // 3. Insert one-time recovery code
      db.prepare(`
        INSERT INTO recovery_codes (id, user_id, code_hash, used_at, created_at)
        VALUES (?, ?, ?, NULL, ?)
      `).run(recoveryId, userId, recoveryHash, now);

      // 4. Ensure default categories are seeded for this new owner
      seedDefaultCategoriesIfEmpty(db, userId);

      // 5. Create active session
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const sessionId = generateId('sess');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      db.prepare(`
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sessionId, userId, tokenHash, expiresAt, now, now);

      // 6. Permanently close the initialization entry (one-way, inside the same transaction)
      this.markOwnerInitialized(db);

      db.exec('COMMIT;');

      return {
        success: true,
        user: {
          id: userId,
          username: username.trim(),
          role: 'owner',
        },
        token,
        recoveryCode,
      };
    } catch (err: any) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // ignore rollback error if connection lost
      }
      return {
        success: false,
        code: err?.message?.includes('UNIQUE') ? 'ALREADY_INITIALIZED' : 'INIT_FAILED',
        message: err?.message?.includes('UNIQUE') ? '系统主理人账号已存在，无法重复初始化' : (err?.message || '初始化主理人账号失败'),
      };
    }
  }

  /**
   * Verifies owner credentials using salted scrypt, with automatic migration from legacy SHA-256.
   */
  public verifyOwner(password: string): { success: boolean; user?: any; token?: string; message?: string } {
    const db = this.getDb();
    const user = db.prepare('SELECT id, username, password_hash, role, is_active FROM users WHERE role = ? LIMIT 1').get('owner') as any;

    if (!user || !user.is_active) {
      return { success: false, message: '主理人账号未初始化或已被禁用' };
    }

    const { isValid, needsRehash } = verifyPassword(password, user.password_hash);
    if (!isValid) {
      return { success: false, message: '访问密码错误，认证失败' };
    }

    // Transparently upgrade legacy SHA-256 hash to salted scrypt
    if (needsRehash) {
      const upgradedHash = hashPassword(password);
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
        upgradedHash,
        new Date().toISOString(),
        user.id
      );
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const sessionId = generateId('sess');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    db.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, user.id, tokenHash, expiresAt, now.toISOString(), now.toISOString());

    return {
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
      token,
    };
  }

  /**
   * Validates an active session token against the database.
   * Tokens that are missing, invalid, or expired are strictly rejected.
   */
  public validateSession(token: string): { isValid: boolean; user?: any } {
    if (!token || typeof token !== 'string') return { isValid: false };
    const db = this.getDb();
    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
    const now = new Date().toISOString();

    const row = db.prepare(`
      SELECT s.id as session_id, s.expires_at, s.last_seen_at, u.id as user_id, u.username, u.role, u.is_active
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(tokenHash, now) as any;

    if (!row || !row.is_active) {
      return { isValid: false };
    }

    // Refresh last_seen_at only if more than 2 minutes elapsed (throttle DB writes)
    const lastSeenTime = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
    if (Date.now() - lastSeenTime > 2 * 60 * 1000) {
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, row.session_id);
    }

    return {
      isValid: true,
      user: {
        id: row.user_id,
        username: row.username,
        role: row.role,
      },
    };
  }

  /**
   * Logs out the user by explicitly revoking their session.
   */
  public logout(token: string): void {
    if (!token) return;
    const db = this.getDb();
    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  /**
   * Updates owner password, automatically revoking all previous active sessions.
   */
  public updateOwnerPassword(userId: string, newPasscode: string): boolean {
    if (!newPasscode || newPasscode.length < 6) return false;
    const db = this.getDb();
    const newHash = hashPassword(newPasscode);
    const now = new Date().toISOString();

    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(newHash, now, userId);

    // Revoke all existing sessions for this user on password change
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);

    return true;
  }

  /**
   * Resets password using either the verified old password or a valid one-time recovery code.
   * Hardcoded master recovery codes and email resets are completely removed.
   */
  public resetPassword(params: {
    username?: string;
    oldPassword?: string;
    recoveryCode?: string;
    newPassword: string;
  }): { success: boolean; message: string; newRecoveryCode?: string } {
    const { username = 'owner', oldPassword, recoveryCode, newPassword } = params;

    if (!newPassword || newPassword.length < 6) {
      return { success: false, message: '新密码最低长度要求 6 位' };
    }

    const db = this.getDb();
    db.exec('BEGIN IMMEDIATE;');

    try {
      const user = db.prepare('SELECT id, username, email, password_hash, role FROM users WHERE role = ? OR username = ? LIMIT 1').get('owner', username) as any;

      if (!user) {
        db.exec('ROLLBACK;');
        return { success: false, message: '未找到指定的所有者账号' };
      }

      let isAuthorized = false;
      let matchedRecoveryId: string | null = null;

      // 1. Verify old password if provided
      if (oldPassword) {
        const { isValid } = verifyPassword(oldPassword, user.password_hash);
        if (isValid) {
          isAuthorized = true;
        }
      }

      // 2. Or verify secure one-time cryptographic recovery code
      if (!isAuthorized && recoveryCode) {
        const codeHash = hashRecoveryCode(recoveryCode);
        const activeCode = db.prepare(`
          SELECT id FROM recovery_codes
          WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
          LIMIT 1
        `).get(user.id, codeHash) as any;

        if (activeCode?.id) {
          isAuthorized = true;
          matchedRecoveryId = activeCode.id;
        }
      }

      if (!isAuthorized) {
        db.exec('ROLLBACK;');
        return { success: false, message: '原密码或应急恢复密钥核验失败，无法重置密码' };
      }

      const now = new Date().toISOString();

      // If recovery code was used, atomically invalidate it with conditional update checking affected rows
      if (matchedRecoveryId) {
        const updateRes = db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now, matchedRecoveryId);
        if (updateRes.changes !== 1) {
          db.exec('ROLLBACK;');
          return { success: false, message: '应急恢复密钥已被使用或已失效' };
        }
      }

      // Update password with salted scrypt
      const newHash = hashPassword(newPassword);
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(newHash, now, user.id);

      // Invalidate all active sessions for this user
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

      // Issue a fresh one-time recovery code so the owner maintains emergency recovery capability
      const newRecoveryCode = this.generateRecoveryCode();
      const newRecoveryHash = hashRecoveryCode(newRecoveryCode);
      const newRecoveryId = generateId('rec');
      db.prepare(`
        INSERT INTO recovery_codes (id, user_id, code_hash, used_at, created_at)
        VALUES (?, ?, ?, NULL, ?)
      `).run(newRecoveryId, user.id, newRecoveryHash, now);

      db.exec('COMMIT;');

      return {
        success: true,
        message: '密码重置成功，请使用新密码重新登录',
        newRecoveryCode,
      };
    } catch (err: any) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // ignore rollback error
      }
      return { success: false, message: err?.message || '重置密码操作失败' };
    }
  }

  public getOwnerProfile(): any {
    const db = this.getDb();
    const user = db.prepare('SELECT id, username, email, role, created_at, updated_at FROM users WHERE role = ? LIMIT 1').get('owner') as any;
    return user || null;
  }

  public updateOwnerProfile(profile: { username?: string; email?: string }): boolean {
    const db = this.getDb();
    const now = new Date().toISOString();
    const currentUser = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('owner') as any;
    if (!currentUser) return false;

    if (profile.username && profile.email) {
      db.prepare('UPDATE users SET username = ?, email = ?, updated_at = ? WHERE id = ?').run(
        profile.username.trim(),
        profile.email.trim(),
        now,
        currentUser.id
      );
    } else if (profile.username) {
      db.prepare('UPDATE users SET username = ?, updated_at = ? WHERE id = ?').run(
        profile.username.trim(),
        now,
        currentUser.id
      );
    } else if (profile.email) {
      db.prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?').run(
        profile.email.trim(),
        now,
        currentUser.id
      );
    }
    return true;
  }
}

export const authService = new AuthService();
