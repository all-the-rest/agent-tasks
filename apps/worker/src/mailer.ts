import { createTransport } from 'nodemailer';

export interface Mailer {
  send(message: { to: string; subject: string; text: string; html?: string }): Promise<void>;
  readonly kind: 'smtp' | 'log';
}

/**
 * Completion notifications use the same transport contract as the API mailer:
 * real SMTP when `SMTP_URL` is set, otherwise structured log output (development).
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
          ...(message.html ? { html: message.html } : {}),
        });
      },
    };
  }
  return {
    kind: 'log',
    async send(message) {
      console.info(
        JSON.stringify({
          level: 'info',
          event: 'mail_dev',
          to: message.to,
          subject: message.subject,
          body: options.nodeEnv === 'production' ? '[redacted in production]' : message.text,
        }),
      );
    },
  };
}
