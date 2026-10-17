// Ported from backend-vour-carousels/src/services/omniroute-gate.ts.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Limits concurrency and spaces request starts for one provider within a process.
 * (Serverless instances each get their own gate; cross-instance limits rely on the DB quota.)
 */
export class RequestGate {
  private active = 0;
  private waiters: Array<() => void> = [];
  private lastStart = 0;

  constructor(private readonly config: () => { maxConcurrent: number; minIntervalMs: number }) {}

  private async acquire(): Promise<void> {
    // Loop: a caller arriving between release and the woken waiter's turn must not over-admit.
    while (this.active >= this.config().maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    // Claim the start slot before sleeping so simultaneous callers don't wake together.
    const now = Date.now();
    const startAt = Math.max(now, this.lastStart + this.config().minIntervalMs);
    this.lastStart = startAt;
    if (startAt > now) await sleep(startAt - now);
  }

  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
