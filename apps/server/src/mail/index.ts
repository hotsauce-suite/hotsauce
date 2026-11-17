// Email (docs/PLAN-sign.md R12). Sign sends signing links and finished copies through a Mailer;
// Resend implements it in production, a fake in tests, and without a key nothing is sent (the
// sender copies links instead).

import { HotsauceError } from '../errors.js'

export interface MailAttachment {
  filename: string
  content: Uint8Array
}

export interface MailMessage {
  to: string
  /** The display name in From, like "Ada Lovelace via Acme"; the address is the server's. */
  fromName: string
  replyTo?: string | undefined
  subject: string
  text: string
  html: string
  attachments?: MailAttachment[] | undefined
}

export interface Mailer {
  /** Whether this server can send email at all. */
  readonly available: boolean
  send(message: MailMessage): Promise<void>
}

/** No email on this server: Send gives the sender links to copy. */
export class NoMailer implements Mailer {
  readonly available = false
  async send(): Promise<void> {
    throw new HotsauceError('not_configured', 'Email isn’t set up on this server')
  }
}

/** Keeps what it was asked to send, for tests and the dev server. */
export class FakeMailer implements Mailer {
  readonly available = true
  readonly sent: MailMessage[] = []
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message)
  }
}

const RESEND = 'https://api.resend.com/emails'

/** Resend's API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendMailer implements Mailer {
  readonly available = true
  readonly #key: string
  readonly #from: string
  readonly #fetch: typeof fetch

  constructor(opts: { apiKey: string; from: string; fetch?: typeof fetch }) {
    this.#key = opts.apiKey
    this.#from = opts.from
    this.#fetch = opts.fetch ?? fetch
  }

  async send(m: MailMessage): Promise<void> {
    // Quotes, backslashes and angle brackets would break the From header.
    const name = m.fromName.replace(/["\\<>\r\n]/g, '').slice(0, 120)
    const body = {
      from: `"${name}" <${this.#from}>`,
      to: [m.to],
      ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      subject: m.subject.replace(/[\r\n]+/g, ' ').slice(0, 300),
      text: m.text,
      html: m.html,
      ...(m.attachments?.length
        ? {
            attachments: m.attachments.map((a) => ({
              filename: a.filename,
              content: Buffer.from(a.content).toString('base64'),
            })),
          }
        : {}),
    }
    let res: Response
    try {
      res = await this.#fetch(RESEND, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (err) {
      throw new HotsauceError('host_error', `Couldn’t reach Resend to send email (${err})`)
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new HotsauceError(
        'host_error',
        `Resend didn’t send the email (${res.status}) ${detail}`,
      )
    }
  }
}

/** The server's mailer: Resend with a key and a From address, a fake in dev and tests. */
export function mailerFor(config: {
  NODE_ENV: string
  RESEND_API_KEY?: string | undefined
  MAIL_FROM?: string | undefined
}): Mailer {
  if (config.RESEND_API_KEY && config.MAIL_FROM) {
    return new ResendMailer({ apiKey: config.RESEND_API_KEY, from: config.MAIL_FROM })
  }
  return config.NODE_ENV === 'production' ? new NoMailer() : new FakeMailer()
}

/** Escapes text for an email's HTML body. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  )
}
