import { NotificationService } from '../services/NotificationService';

export interface NotificationWorkerOptions {
  /** How often to poll the outbox, in milliseconds. Defaults to 5000. */
  intervalMs?: number;
  /** Maximum number of rows to process per tick. Defaults to 50. */
  batchSize?: number;
  /** Logger used for lifecycle and failure messages. */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export class NotificationWorker {
  private readonly service: NotificationService;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = true;
  private inFlight: Promise<void> | null = null;

  constructor(service: NotificationService, options: NotificationWorkerOptions = {}) {
    this.service = service;
    this.intervalMs = options.intervalMs ?? 5000;
    this.batchSize = options.batchSize ?? 50;
    this.logger = options.logger ?? console;
  }

  /**
   * Starts the polling loop. Safe to call multiple times; subsequent calls
   * while already running are ignored.
   */
  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.logger.info(
      `[notificationWorker] started (interval=${this.intervalMs}ms, batchSize=${this.batchSize})`,
    );
    this.scheduleNext(0);
  }

  /**
   * Stops the polling loop and waits for any in-flight tick to finish.
   */
  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // Errors are already logged inside the tick.
      }
    }
    this.logger.info('[notificationWorker] stopped');
  }

  /**
   * Runs a single drain pass. Exposed for tests and manual invocation.
   * Returns the number of rows processed.
   */
  async runOnce(): Promise<number> {
    try {
      const processed = await this.service.processPending(this.batchSize);
      if (processed > 0) {
        this.logger.info(`[notificationWorker] processed ${processed} notification(s)`);
      }
      return processed;
    } catch (err) {
      this.logger.error('[notificationWorker] failed to process pending notifications', err);
      return 0;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    // Do not keep the process alive solely for the poll timer.
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) {
      if (!this.stopped) {
        this.scheduleNext(this.intervalMs);
      }
      return;
    }
    this.running = true;
    this.inFlight = this.runOnce().then(() => undefined);
    try {
      await this.inFlight;
    } finally {
      this.running = false;
      this.inFlight = null;
      if (!this.stopped) {
        this.scheduleNext(this.intervalMs);
      }
    }
  }
}

/**
 * Convenience factory used by the app bootstrap.
 */
export function createNotificationWorker(
  service: NotificationService,
  options?: NotificationWorkerOptions,
): NotificationWorker {
  return new NotificationWorker(service, options);
}