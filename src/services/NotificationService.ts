import { Pool, PoolClient } from 'pg';
import { Resend } from 'resend';
import nodemailer, { Transporter } from 'nodemailer';

/**
 * Notification types supported by the outbox.
 */
export type NotificationType = 'kyc_decision' | 'yield_available';

/**
 * A row in the `notifications` outbox table.
 */
export interface NotificationRow {
  id: string;
  user_id: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Minimal provider abstraction so we can swap Resend for SMTP (or a mock in tests).
 */
export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 60_000; // 1 minute

/**
 * Compute the delay before the next attempt using exponential backoff.
 * attempt 1 -> 1m, 2 -> 2m, 3 -> 4m, 4 -> 8m, 5 -> 16m (capped by MAX_ATTEMPTS).
 */
export function backoffDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return BASE_BACKOFF_MS * Math.pow(2, exponent);
}

/**
 * Resend-backed provider.
 */
export class ResendEmailProvider implements EmailProvider {
  private client: Resend;
  private from: string;

  constructor(apiKey: string, from: string) {
    this.client = new Resend(apiKey);
    this.from = from;
  }

  async send(message: EmailMessage): Promise<void> {
    const result = await this.client.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    if (result.error) {
      throw new Error(result.error.message ?? 'Resend send failed');
    }
  }
}

/**
 * SMTP-backed provider.
 */
export class SmtpEmailProvider implements EmailProvider {
  private transporter: Transporter;
  private from: string;

  constructor(options: { host: string; port: number; user?: string; pass?: string; from: string }) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.port === 465,
      auth:
        options.user && options.pass
          ? { user: options.user, pass: options.pass }
          : undefined,
    });
    this.from = options.from;
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}

export interface NotificationServiceOptions {
  pool: Pool;
  provider: EmailProvider;
  from?: string;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

interface KycDecisionPayload {
  decision: 'approved' | 'rejected';
  reason?: string;
}

interface YieldAvailablePayload {
  amount: string;
  asset?: string;
  claimUrl?: string;
}

/**
 * NotificationService writes outbox rows and dispatches pending emails.
 *
 * Outbox rows are written by callers within the same transaction as the
 * business event (KYC review, distribution) using the `enqueue*` helpers,
 * which accept an optional `PoolClient` so they participate in that tx.
 */
export class NotificationService {
  private pool: Pool;
  private provider: EmailProvider;
  private from: string;
  private logger: Pick<Console, 'info' | 'warn' | 'error'>;

  constructor(options: NotificationServiceOptions) {
    this.pool = options.pool;
    this.provider = options.provider;
    this.from = options.from ?? 'no-reply@example.com';
    this.logger = options.logger ?? console;
  }

  /**
   * Enqueue a KYC decision notification. Pass `client` to run inside an
   * existing transaction.
   */
  async enqueueKycDecision(
    userId: string,
    payload: KycDecisionPayload,
    client?: PoolClient,
  ): Promise<NotificationRow> {
    return this.enqueue(userId, 'kyc_decision', payload as unknown as Record<string, unknown>, client);
  }

  /**
   * Enqueue a "new yield available" notification. Pass `client` to run inside
   * an existing transaction.
   */
  async enqueueYieldAvailable(
    userId: string,
    payload: YieldAvailablePayload,
    client?: PoolClient,
  ): Promise<NotificationRow> {
    return this.enqueue(userId, 'yield_available', payload as unknown as Record<string, unknown>, client);
  }

  private async enqueue(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown>,
    client?: PoolClient,
  ): Promise<NotificationRow> {
    const executor = client ?? this.pool;
    const result = await executor.query<NotificationRow>(
      `INSERT INTO notifications (user_id, type, payload, status, attempts, next_attempt_at)
       VALUES ($1, $2, $3, 'pending', 0, NOW())
       RETURNING *`,
      [userId, type, JSON.stringify(payload)],
    );
    return result.rows[0];
  }

  /**
   * Fetch and send all pending notifications whose next_attempt_at has passed.
   * Returns the number of rows successfully sent.
   */
  async processPending(limit = 50): Promise<number> {
    const due = await this.pool.query<NotificationRow>(
      `SELECT n.*, u.email AS user_email
         FROM notifications n
         JOIN users u ON u.id = n.user_id
        WHERE n.status = 'pending'
          AND n.next_attempt_at <= NOW()
        ORDER BY n.next_attempt_at ASC
        LIMIT $1
        FOR UPDATE OF n SKIP LOCKED`,
      [limit],
    );

    let sent = 0;
    for (const row of due.rows) {
      const ok = await this.deliver(row);
      if (ok) sent += 1;
    }
    return sent;
  }

  private async deliver(row: NotificationRow & { user_email?: string }): Promise<boolean> {
    const email = row.user_email;
    if (!email) {
      await this.markFailure(row, 'missing recipient email');
      return false;
    }

    try {
      const message = this.buildMessage(email, row);
      await this.provider.send(message);
      await this.markSent(row.id);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`notification ${row.id} send failed: ${message}`);
      await this.markFailure(row, message);
      return false;
    }
  }

  private async markSent(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE notifications
          SET status = 'sent',
              sent_at = NOW(),
              updated_at = NOW(),
              last_error = NULL
        WHERE id = $1`,
      [id],
    );
  }

  private async markFailure(row: NotificationRow, error: string): Promise<void> {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.pool.query(
        `UPDATE notifications
            SET status = 'failed',
                attempts = $2,
                last_error = $3,
                updated_at = NOW()
          WHERE id = $1`,
        [row.id, attempts, error],
      );
      this.logger.error(`notification ${row.id} permanently failed after ${attempts} attempts`);
      return;
    }

    const delayMs = backoffDelayMs(attempts);
    await this.pool.query(
      `UPDATE notifications
          SET attempts = $2,
              last_error = $3,
              next_attempt_at = NOW() + ($4::int * INTERVAL '1 millisecond'),
              updated_at = NOW()
        WHERE id = $1`,
      [row.id, attempts, error, delayMs],
    );
  }

  private buildMessage(to: string, row: NotificationRow): EmailMessage {
    switch (row.type) {
      case 'kyc_decision': {
        const payload = row.payload as unknown as KycDecisionPayload;
        const approved = payload.decision === 'approved';
        const subject = approved ? 'Your KYC has been approved' : 'Your KYC review is complete';
        const body = approved
          ? 'Good news — your identity verification has been approved. You can now invest.'
          : `Unfortunately your identity verification was not approved.${
              payload.reason ? ` Reason: ${payload.reason}` : ''
            }`;
        return {
          to,
          subject,
          html: `<p>${escapeHtml(body)}</p>`,
          text: body,
        };
      }
      case 'yield_available': {
        const payload = row.payload as unknown as YieldAvailablePayload;
        const amount = payload.amount;
        const asset = payload.asset ? ` ${payload.asset}` : '';
        const subject = 'New yield is ready to claim';
        const body = `You have ${amount}${asset} of yield ready to claim.${
          payload.claimUrl ? ` Claim it here: ${payload.claimUrl}` : ''
        }`;
        return {
          to,
          subject,
          html: `<p>${escapeHtml(body)}</p>`,
          text: body,
        };
      }
      default: {
        const subject = 'Notification';
        const body = 'You have a new notification.';
        return { to, subject, html: `<p>${body}</p>`, text: body };
      }
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build a provider from environment configuration.
 * EMAIL_PROVIDER selects 'resend' (default) or 'smtp'.
 */
export function createEmailProviderFromEnv(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  const provider = (env.EMAIL_PROVIDER ?? 'resend').toLowerCase();
  const from = env.EMAIL_FROM ?? 'no-reply@example.com';

  if (provider === 'smtp') {
    if (!env.SMTP_HOST) {
      throw new Error('SMTP_HOST is required when EMAIL_PROVIDER=smtp');
    }
    return new SmtpEmailProvider({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT ?? 587),
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from,
    });
  }

  if (provider === 'resend') {
    const key = env.EMAIL_PROVIDER_KEY;
    if (!key) {
      throw new Error('EMAIL_PROVIDER_KEY is required when EMAIL_PROVIDER=resend');
    }
    return new ResendEmailProvider(key, from);
  }

  throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
}