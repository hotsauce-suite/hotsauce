// The emails Sign sends (docs/PLAN-sign.md R12, R16): a signing link, the finished copies, and a
// decline. Plain words, a text part and a simple HTML part; nothing is tracked.

import { escapeHtml } from '../mail/index.js'

export interface EmailBody {
  subject: string
  text: string
  html: string
}

const wrap = (paragraphs: string[], button?: { label: string; url: string }) => {
  const ps = paragraphs.map((p) => `<p style="margin:0 0 14px">${escapeHtml(p)}</p>`).join('')
  const btn = button
    ? `<p style="margin:20px 0"><a href="${escapeHtml(button.url)}" style="background:#a94e26;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">${escapeHtml(button.label)}</a></p><p style="margin:0 0 14px;color:#555;font-size:13px">Or open this link: ${escapeHtml(button.url)}</p>`
    : ''
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#16262d;max-width:560px;margin:0 auto;padding:24px">${ps}${btn}</body></html>`
}

/** Asks someone to sign, with their own link. */
export function signingLinkEmail(a: {
  to: string
  sender: string
  org: string
  title: string
  url: string
  expires: string
  reminder?: boolean
}): EmailBody {
  const lines = [
    `Hi ${a.to},`,
    `${a.sender} at ${a.org} asks you to sign “${a.title}”.`,
    'Open the link to read the document and sign it. You don’t need an account.',
    `The link is just for you and works until ${a.expires}. Don’t forward it.`,
  ]
  return {
    subject: `${a.reminder ? 'Reminder: please' : 'Please'} sign “${a.title}”`,
    text: `${lines.join('\n\n')}\n\n${a.url}\n`,
    html: wrap(lines, { label: 'Review and sign', url: a.url }),
  }
}

/** Everyone gets the sealed PDF and certificate when the last person signs. */
export function completedEmail(a: { to: string; title: string; org: string }): EmailBody {
  const lines = [
    `Hi ${a.to},`,
    `Everyone has signed “${a.title}”.`,
    'The signed PDF and its audit certificate are attached. The PDF is sealed, so a PDF reader shows if anyone changes it.',
    `Sent by ${a.org}.`,
  ]
  return {
    subject: `Signed: “${a.title}”`,
    text: `${lines.join('\n\n')}\n`,
    html: wrap(lines),
  }
}

/** Tells the sender someone declined. */
export function declinedEmail(a: {
  signer: string
  title: string
  reason: string | null
  url: string
}): EmailBody {
  const lines = [
    `${a.signer} declined to sign “${a.title}”, so nobody else can sign it now.`,
    a.reason ? `Their reason: ${a.reason}` : 'They didn’t give a reason.',
  ]
  return {
    subject: `Declined: “${a.title}”`,
    text: `${lines.join('\n\n')}\n\n${a.url}\n`,
    html: wrap(lines, { label: 'Open the envelope', url: a.url }),
  }
}
