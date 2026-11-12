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

export interface RuntimeStateSnapshot {
  status: RuntimeStatus;
  writeAllowed: boolean;
  reason: string | null;
  warnings: string[];
  since: string;
}

class MaintenanceState {
  private status: RuntimeStatus = 'ok';
  private reason: string | null = null;
  private warnings: string[] = [];
  private since = new Date().toISOString();

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

  public snapshot(): RuntimeStateSnapshot {
    return {
      status: this.status,
      writeAllowed: this.isWriteAllowed(),
      reason: this.reason,
      warnings: [...this.warnings],
      since: this.since,
    };
  }

  /** Test-only helper; production never calls this. */
  public resetForTests(): void {
    this.status = 'ok';
    this.reason = null;
    this.warnings = [];
    this.since = new Date().toISOString();
  }
}

export const maintenanceState = new MaintenanceState();
