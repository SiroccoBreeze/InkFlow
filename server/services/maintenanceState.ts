/**
 * Process-wide runtime state for startup recovery / maintenance mode.
 *
 * Regulation:
 *  - `ok`          — every critical and non-critical startup task succeeded.
 *  - `degraded`    — a non-critical maintenance task failed (tombstone retry,
 *                    seed rebuild, asset-reference rebuild). Reads AND writes
 *                    remain available; the failure is reported in /api/health.
 *  - `maintenance` — a critical recovery task failed (unfinished document save
 *                    or document deletion recovery). The server listens for
 *                    diagnostics, but every non-read HTTP request is rejected
 *                    with 503 MAINTENANCE_MODE.
 *
 * The state is intentionally process-local: every start re-runs recovery and
 * re-evaluates it. It is not persisted, so fixing the filesystem and restarting
 * is the documented way out.
 */

export type RuntimeStatus = 'ok' | 'degraded' | 'maintenance';

/**
 * Trust state of the derived `document_assets` association table.
 *
 * This is deliberately separate from RuntimeStatus: a failed attachment
 * tombstone retry degrades the service but does NOT invalidate the association
 * table, whereas a failed startup rebuild does. Only `unavailable` makes the
 * asset route fail closed for anonymous readers.
 */
export type AssetReferenceIntegrity = 'ready' | 'unavailable';

export interface RuntimeStateSnapshot {
  status: RuntimeStatus;
  writeAllowed: boolean;
  reason: string | null;
  warnings: string[];
  since: string;
  assetReferenceIntegrity: AssetReferenceIntegrity;
  assetReferenceIntegrityReason: string | null;
}

class MaintenanceState {
  private status: RuntimeStatus = 'ok';
  private reason: string | null = null;
  private warnings: string[] = [];
  private since = new Date().toISOString();
  // Defaults to `ready` so an in-process router (tests, alternate entry points)
  // keeps today's behaviour. The startup path explicitly marks `unavailable` when
  // calibration fails.
  private assetReferenceIntegrity: AssetReferenceIntegrity = 'ready';
  private assetReferenceIntegrityReason: string | null = null;

  public enterMaintenance(reason: string): void {
    this.status = 'maintenance';
    this.reason = reason;
    this.since = new Date().toISOString();
  }

  public addDegradedWarning(warning: string): void {
    // A critical failure always wins; never downgrade maintenance → degraded.
    if (this.status === 'maintenance') return;
    if (!this.warnings.includes(warning)) this.warnings.push(warning);
    if (this.status !== 'degraded') {
      this.status = 'degraded';
      this.since = new Date().toISOString();
    }
  }

  public isWriteAllowed(): boolean {
    return this.status !== 'maintenance';
  }

  public isMaintenance(): boolean {
    return this.status === 'maintenance';
  }

  /**
   * Records that the Markdown → `document_assets` rebuild completed. Called on
   * startup before requests are accepted, so anonymous readers may trust the
   * association table again.
   */
  public markAssetReferencesReady(): void {
    this.assetReferenceIntegrity = 'ready';
    this.assetReferenceIntegrityReason = null;
  }

  /**
   * Records that the association table could not be calibrated against the
   * Markdown SSOT. Anonymous asset access must fail closed until a successful
   * restart; owner access is unaffected. The failure is also surfaced as a
   * degraded warning (unless the service is already in full maintenance mode,
   * where the critical reason is more important).
   */
  public markAssetReferencesUnavailable(reason: string): void {
    this.assetReferenceIntegrity = 'unavailable';
    this.assetReferenceIntegrityReason = reason;
    this.addDegradedWarning('文档↔附件引用重建失败，匿名附件访问已关闭');
  }

  /** Whether the association table is trustworthy for anonymous authorization. */
  public isAssetReferenceIntegrityTrusted(): boolean {
    return this.assetReferenceIntegrity === 'ready';
  }

  public snapshot(): RuntimeStateSnapshot {
    return {
      status: this.status,
      writeAllowed: this.isWriteAllowed(),
      reason: this.reason,
      warnings: [...this.warnings],
      since: this.since,
      assetReferenceIntegrity: this.assetReferenceIntegrity,
      assetReferenceIntegrityReason: this.assetReferenceIntegrityReason,
    };
  }

  /** Test-only helper; production never calls this. */
  public resetForTests(): void {
    this.status = 'ok';
    this.reason = null;
    this.warnings = [];
    this.since = new Date().toISOString();
    this.assetReferenceIntegrity = 'ready';
    this.assetReferenceIntegrityReason = null;
  }
}

export const maintenanceState = new MaintenanceState();
