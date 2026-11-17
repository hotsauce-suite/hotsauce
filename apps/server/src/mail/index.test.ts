import { describe, expect, it } from 'vitest'
import { escapeHtml, FakeMailer, mailerFor, NoMailer, ResendMailer } from './index.js'

describe('mailers (R12)', () => {
  it('posts to Resend with the name, reply-to and base64 attachments', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('{"id":"x"}', { status: 200 })
    }) as unknown as typeof fetch
    const mailer = new ResendMailer({
      apiKey: 're_test',
      from: 'sign@mail.example.test',
      fetch: fake,
    })
    await mailer.send({
      to: 'maya@example.org',
      fromName: 'Ada "A" <Lovelace> via Fieldwork',
      replyTo: 'ada@example.test',
      subject: 'Please sign\r\nBcc: x',
      text: 'hi',
      html: '<p>hi</p>',
      attachments: [{ filename: 'a.pdf', content: new Uint8Array([1, 2, 3]) }],
    })
    expect(calls[0]?.url).toBe('https://api.resend.com/emails')
    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body).toMatchObject({
      from: '"Ada A Lovelace via Fieldwork" <sign@mail.example.test>',
      to: ['maya@example.org'],
      reply_to: 'ada@example.test',
      subject: 'Please sign Bcc: x',
      attachments: [{ filename: 'a.pdf', content: 'AQID' }],
    })
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer re_test')
  })

  it('says plainly when Resend refuses', async () => {
    const fake = (async () =>
      new Response('domain not verified', { status: 403 })) as unknown as typeof fetch
    const mailer = new ResendMailer({ apiKey: 're_test', from: 'a@b.test', fetch: fake })
    await expect(
      mailer.send({ to: 'x@y.test', fromName: 'A', subject: 's', text: 't', html: 'h' }),
    ).rejects.toThrow(/403.*domain not verified/)
  })

  it('picks Resend only with a key and a From address', () => {
    expect(
      mailerFor({ NODE_ENV: 'production', RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.test' }),
    ).toBeInstanceOf(ResendMailer)
    expect(mailerFor({ NODE_ENV: 'production', RESEND_API_KEY: 'k' })).toBeInstanceOf(NoMailer)
    expect(mailerFor({ NODE_ENV: 'test' })).toBeInstanceOf(FakeMailer)
  })

  it('escapes HTML', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    )
  })
})
