import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import nodemailer from 'nodemailer';

import type { AppConfig, SmtpConfig } from '../../config/env.js';

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  purpose: string;
};

export class EmailDeliveryError extends Error {
  constructor() {
    super('Email delivery failed');
    this.name = 'EmailDeliveryError';
  }
}

export interface EmailSender {
  readonly mode: 'capture' | 'unconfigured' | 'smtp';
  readonly canSend: boolean;
  send(message: EmailMessage): Promise<void>;
}

export class CaptureEmailSender implements EmailSender {
  readonly mode = 'capture' as const;
  readonly canSend = true;
  readonly messages: EmailMessage[] = [];

  constructor(private readonly outboxPath: string | null) {}

  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
    if (!this.outboxPath) return;
    await mkdir(path.dirname(this.outboxPath), { recursive: true });
    await appendFile(
      this.outboxPath,
      `${JSON.stringify({ at: new Date().toISOString(), ...message })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  }
}

export class UnconfiguredEmailSender implements EmailSender {
  readonly mode = 'unconfigured' as const;
  readonly canSend = false;

  send(): Promise<void> {
    return Promise.reject(new EmailDeliveryError());
  }
}

export function createEmailSender(config: AppConfig): EmailSender {
  if (config.emailDelivery === 'capture') return new CaptureEmailSender(config.emailOutboxPath);
  if (config.emailDelivery === 'smtp' && config.smtp) return new SmtpEmailSender(config.smtp);
  return new UnconfiguredEmailSender();
}

export class SmtpEmailSender implements EmailSender {
  readonly mode = 'smtp' as const;
  readonly canSend = true;

  constructor(private readonly smtp: SmtpConfig) {}

  async send(message: EmailMessage): Promise<void> {
    const transport = nodemailer.createTransport({
      host: this.smtp.host,
      port: this.smtp.port,
      secure: this.smtp.secure,
      auth:
        this.smtp.user === null || this.smtp.password === null
          ? undefined
          : { user: this.smtp.user, pass: this.smtp.password },
    });
    try {
      await transport.sendMail({
        from: this.smtp.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    } catch {
      throw new EmailDeliveryError();
    }
  }
}
