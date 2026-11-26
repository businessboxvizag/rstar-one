import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly mode: "log" | "memory" | "smtp";
  send(mail: Mail): Promise<void>;
}

/**
 * TEST MODE mailer: writes the message to the server log and never delivers it.
 * Real delivery needs MAIL_TRANSPORT=smtp + SMTP_URL (see docs/integrations.md).
 */
export class LogMailer implements Mailer {
  readonly mode = "log" as const;
  constructor(private log: FastifyBaseLogger) {}
  async send(mail: Mail) {
    this.log.warn({ mail: { to: mail.to, subject: mail.subject } }, "[MAIL TEST MODE] email not delivered");
    this.log.debug({ body: mail.text }, "[MAIL TEST MODE] body");
  }
}

/** Used by automated tests to read what would have been sent. */
export class MemoryMailer implements Mailer {
  readonly mode = "memory" as const;
  outbox: Mail[] = [];
  async send(mail: Mail) {
    this.outbox.push(mail);
  }
}

export function createMailer(config: Config, log: FastifyBaseLogger): Mailer {
  if (config.MAIL_TRANSPORT === "memory") return new MemoryMailer();
  if (config.MAIL_TRANSPORT === "smtp") {
    // Not implemented until SMTP credentials are provided; fail loudly rather than pretend.
    throw new Error("SMTP transport is not configured yet. Set MAIL_TRANSPORT=log for test mode. See docs/integrations.md.");
  }
  return new LogMailer(log);
}
