import { createTransport } from 'nodemailer';

export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
  readonly kind: 'smtp' | 'log';
}

/**
 * Real SMTP when `SMTP_URL` is configured (production). In development the message
 * is written to the log *without* the token-bearing link? No — a reset link is the
 * only way to continue, so the link is logged in development and truncated in
 * production. Tokens are never logged in production.
 */
export function createMailer(options: { smtpUrl?: string; from?: string; nodeEnv: string }): Mailer {
  if (options.smtpUrl) {
    const transport = createTransport(options.smtpUrl);
    return {
      kind: 'smtp',
      async send(message) {
        await transport.sendMail({
          from: options.from ?? 'agent-tasks@localhost',
          to: message.to,
          subject: message.subject,
          text: message.text,
        });
      },
    };
  }
  return {
    kind: 'log',
    async send(message) {
      const preview = options.nodeEnv === 'production' ? '[redacted link in production]' : message.text;
      console.info(JSON.stringify({ level: 'info', event: 'mail_dev', to: message.to, subject: message.subject, body: preview }));
    },
  };
}
