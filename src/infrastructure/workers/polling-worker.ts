import { Logger } from '../../application/ports';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Generic polling loop. `tick` returns how much work it found; a full batch triggers an immediate
 * next tick, otherwise the loop sleeps. `stop()` waits for the tick in flight (graceful shutdown).
 */
export class PollingWorker {
  private stopping = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly batchSize: number,
    private readonly tick: () => Promise<number>,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.loop ??= this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    this.logger.info('worker started', { worker: this.name });
    let failures = 0;
    while (!this.stopping) {
      try {
        const worked = await this.tick();
        failures = 0;
        if (worked >= this.batchSize) continue;
        await this.idle(this.intervalMs);
      } catch (error) {
        failures += 1;
        this.logger.warn('worker tick failed', {
          worker: this.name,
          failures,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.idle(Math.min(30_000, this.intervalMs * 2 ** Math.min(failures, 6)));
      }
    }
    this.logger.info('worker stopped', { worker: this.name });
  }

  private idle(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      this.wake = undefined;
    });
  }
}

export { sleep };
