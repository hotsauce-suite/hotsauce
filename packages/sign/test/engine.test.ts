// docs/PLAN-sign.md R1 to R5, at the package's public boundary.
import { createHash } from 'node:crypto'
import forge from 'node-forge'
import { PDFDocument, rgb } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import {
  type AuditEventRecord,
  type ChainedEvent,
  chainAuditEvents,
  createSealIdentity,
  type EnvelopeRecord,
  type FieldRecord,
  makeSealer,
  pdfFingerprint,
  renderCertificate,
  renderSignedPdf,
  type SignerRecord,
  SourceDocumentChangedError,
  verifyAuditChain,
} from '../src/index.ts'

const identity = createSealIdentity({ commonName: 'Fieldwork seal', organization: 'Fieldwork' })
const seal = makeSealer(identity, { name: 'Fieldwork', productName: 'Hotsauce' })
const NOW = 1_800_000_000

/**
 * Checks a PDF's one seal the way a reader does: the digest over the ByteRange matches the
 * signed attributes, and the signature over those attributes verifies with the certificate.
 */
function checkSeal(pdf: Uint8Array): { ok: boolean; covered: number; subFilter: string } {
  const text = Buffer.from(pdf).toString('latin1')
  const range = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text)
  if (!range) throw new Error('no seal')
  const [a, b, c, d] = range.slice(1).map(Number) as [number, number, number, number]
  const subFilter = /\/SubFilter\s*\/([\w.]+)/.exec(text)?.[1] ?? ''
  const covered = Buffer.concat([
    Buffer.from(pdf.subarray(a, a + b)),
    Buffer.from(pdf.subarray(c, c + d)),
  ])
  const hex = text.slice(a + b + 1, c - 1)
  const slot = Buffer.from(hex, 'hex')
  // The slot is zero-padded; the DER header says where the signature ends.
  const first = slot[1] ?? 0
  const lengthBytes = first < 0x80 ? 0 : first & 0x7f
  const length = lengthBytes === 0 ? first : slot.readUIntBE(2, lengthBytes)
  const der = slot.subarray(0, 2 + lengthBytes + length)
  const outer = forge.asn1.fromDer(der.toString('binary'))
  const message = forge.pkcs7.messageFromAsn1(outer) as unknown as {
    certificates: forge.pki.Certificate[]
    rawCapture: { authenticatedAttributes: forge.asn1.Asn1[]; signature: string }
  }
  const attrs = message.rawCapture.authenticatedAttributes
  const digestAttr = attrs.find(
    (attr) =>
      forge.asn1.derToOid((attr.value as forge.asn1.Asn1[])[0]?.value as string) ===
      forge.pki.oids.messageDigest,
  )
  const digestSet = (digestAttr?.value as forge.asn1.Asn1[] | undefined)?.[1]
  const digestValue = (digestSet?.value as forge.asn1.Asn1[] | undefined)?.[0]?.value
  const digest = Buffer.from(typeof digestValue === 'string' ? digestValue : '', 'binary').toString(
    'hex',
  )
  const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs)
  const md = forge.md.sha256.create().update(forge.asn1.toDer(set).getBytes())
  const publicKey = message.certificates[0]?.publicKey as forge.pki.rsa.PublicKey
  const signatureOk = publicKey.verify(md.digest().getBytes(), message.rawCapture.signature)
  const digestOk = digest === createHash('sha256').update(covered).digest('hex')
  return { ok: signatureOk && digestOk, covered: b + d, subFilter }
}

async function sourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc
    .addPage([612, 792])
    .drawRectangle({ x: 50, y: 50, width: 100, height: 20, color: rgb(0.9, 0.9, 0.9) })
  doc.addPage([612, 792])
  return doc.save()
}

/** A one-pixel PNG, standing in for a drawn signature. */
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
)

function records(source: Uint8Array) {
  const envelope: EnvelopeRecord = {
    completedAt: NOW,
    createdAt: NOW - 500,
    declinedAt: null,
    evidenceKey: null,
    id: 'env-1',
    pageCount: 2,
    sentAt: NOW - 400,
    signedPdfKey: null,
    sourcePdfFilename: 'offer.pdf',
    sourcePdfHash: pdfFingerprint(source),
    sourcePdfKey: 'files/offer.pdf',
    sourcePdfSizeBytes: source.byteLength,
    status: 'completed',
    title: 'Offer letter, Zoë Ångström',
    updatedAt: NOW,
    userId: 'member-1',
    voidedAt: null,
  }
  const signer = (id: string, name: string, email: string, order: number): SignerRecord => ({
    createdAt: NOW - 500,
    email,
    id,
    name,
    signedAt: NOW - 100,
    signOrder: order,
    status: 'signed',
    updatedAt: NOW - 100,
  })
  const signers = [
    signer('s-1', 'Zoë Ångström', 'zoe@example.com', 1),
    signer('s-2', 'Maya Ortiz', 'maya@example.com', 2),
  ]
  const base = {
    createdAt: NOW - 500,
    envelopeId: envelope.id,
    height: 0.05,
    page: 1,
    required: true,
    submittedAt: NOW - 100,
    updatedAt: NOW - 100,
    width: 0.3,
    x: 0.1,
  }
  const fields: FieldRecord[] = [
    {
      ...base,
      id: 'f-1',
      signerId: 's-1',
      type: 'signature',
      inputMethod: 'typed',
      value: 'Zoë Ångström',
      y: 0.1,
    },
    {
      ...base,
      id: 'f-2',
      signerId: 's-2',
      type: 'signature',
      inputMethod: 'drawn',
      imageKey: 'sig-maya',
      y: 0.2,
    },
    { ...base, id: 'f-3', signerId: 's-1', type: 'date', value: '2026-11-16', y: 0.3 },
    {
      ...base,
      id: 'f-4',
      signerId: 's-1',
      type: 'text',
      value: 'Санкт-Петербург',
      y: 0.4,
      page: 2,
    },
    { ...base, id: 'f-5', signerId: 's-2', type: 'checkbox', checked: true, y: 0.5, width: 0.04 },
  ]
  const auditEvents: AuditEventRecord[] = [
    {
      actorEmail: 'zoe@example.com',
      actorType: 'signer',
      createdAt: NOW - 100,
      envelopeId: envelope.id,
      event: 'signed',
      id: 'ev-1',
      ipAddress: '203.0.113.7',
      metadata: { signerEmail: 'zoe@example.com', signerId: 's-1', signerName: 'Zoë Ångström' },
      userAgent: 'Mozilla/5.0 (Macintosh)',
    },
  ]
  return { envelope, signers, fields, auditEvents }
}

async function textOf(pdf: Uint8Array): Promise<string> {
  const { getDocumentProxy } = await import('unpdf')
  const doc = await getDocumentProxy(new Uint8Array(pdf))
  const pages: string[] = []
  for (let n = 1; n <= doc.numPages; n += 1) {
    const content = await (await doc.getPage(n)).getTextContent()
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
  }
  return pages.join('\n').replace(/\s+/g, ' ')
}

describe('R1 createSealIdentity', () => {
  it('makes a key and a self-signed certificate valid for 20 years', () => {
    const cert = forge.pki.certificateFromPem(identity.certificatePem)
    expect(identity.privateKeyPem).toMatch(/PRIVATE KEY/)
    expect(identity.certificateChainPem).toEqual([identity.certificatePem])
    expect(cert.subject.getField('CN').value).toBe('Fieldwork seal')
    expect(cert.issuer.getField('CN').value).toBe('Fieldwork seal')
    const years = cert.validity.notAfter.getUTCFullYear() - cert.validity.notBefore.getUTCFullYear()
    expect(years).toBe(20)
  })
})

describe('R2 makeSealer', () => {
  it('seals the whole file, and a changed byte breaks the seal', async () => {
    const doc = await PDFDocument.create()
    doc.addPage()
    const sealed = await seal(doc, 'signed-document')
    const check = checkSeal(sealed)
    expect(check).toMatchObject({ ok: true, subFilter: 'ETSI.CAdES.detached' })
    // The range covers everything except the signature's own slot.
    expect(sealed.byteLength - check.covered).toBeLessThan(60_000)

    const tampered = Uint8Array.from(sealed)
    tampered[20] = tampered[20] === 0x41 ? 0x42 : 0x41
    expect(checkSeal(tampered).ok).toBe(false)
  })
})

describe('R3 renderSignedPdf', () => {
  it('stamps every filled field and seals the result', async () => {
    const source = await sourcePdf()
    const r = records(source)
    const signed = await renderSignedPdf(
      {
        source,
        envelope: r.envelope,
        signers: r.signers,
        fields: r.fields,
        images: new Map([['sig-maya', PNG]]),
      },
      seal,
    )
    expect(checkSeal(signed).ok).toBe(true)
    const text = await textOf(signed)
    expect(text).toContain('Zoë Ångström')
    expect(text).toContain('2026-11-16')
    expect(text).toContain('Санкт-Петербург')
    expect((await PDFDocument.load(signed)).getPageCount()).toBe(2)
  })

  it('refuses a source that is not the one the envelope was sent with', async () => {
    const source = await sourcePdf()
    const r = records(source)
    const other = await sourcePdf()
    const changed = Uint8Array.from(other)
    changed[changed.length - 2] = 0x20
    await expect(
      renderSignedPdf(
        { source: changed, envelope: r.envelope, signers: r.signers, fields: [] },
        seal,
      ),
    ).rejects.toBeInstanceOf(SourceDocumentChangedError)
  })

  it('fails loudly when a drawn signature image was not handed in', async () => {
    const source = await sourcePdf()
    const r = records(source)
    await expect(
      renderSignedPdf({ source, envelope: r.envelope, signers: r.signers, fields: r.fields }, seal),
    ).rejects.toThrow(/sig-maya/)
  })
})

describe('R4 renderCertificate', () => {
  it('lists signers, events and fingerprints, sealed; the recipient copy hides IPs and browsers', async () => {
    const source = await sourcePdf()
    const r = records(source)
    const full = await renderCertificate({ ...r, signedPdfSha256: 'ab'.repeat(32) }, seal)
    const forRecipients = await renderCertificate(
      { ...r, signedPdfSha256: 'ab'.repeat(32), forRecipients: true },
      seal,
    )
    expect(checkSeal(full).ok).toBe(true)
    expect(checkSeal(forRecipients).ok).toBe(true)

    const fullText = await textOf(full)
    expect(fullText).toContain('Certificate of Completion')
    expect(fullText).not.toContain('SignuDoc')
    expect(fullText).toContain('Zoë Ångström')
    expect(fullText).toContain('Maya Ortiz')
    expect(fullText).toContain('203.0.113.7')
    expect(fullText.replace(/\s/g, '')).toContain(r.envelope.sourcePdfHash)

    const recipientText = await textOf(forRecipients)
    expect(recipientText).toContain('Zoë Ångström')
    expect(recipientText).not.toContain('203.0.113.7')
    expect(recipientText).not.toContain('Macintosh')
  })

  it('refuses an envelope that is still out for signature', async () => {
    const source = await sourcePdf()
    const r = records(source)
    await expect(
      renderCertificate({ ...r, envelope: { ...r.envelope, status: 'sent' } }, seal),
    ).rejects.toThrow(/terminal/)
  })
})

describe('R5 audit chain', () => {
  const event = (id: string, event: string, createdAt: number) => ({
    actorEmail: 'zoe@example.com',
    actorType: 'signer',
    createdAt,
    envelopeId: 'env-1',
    event,
    id,
    ipAddress: null,
    metadata: null,
    userAgent: null,
  })
  const chain = chainAuditEvents(
    chainAuditEvents([], [event('a', 'sent', 1), event('b', 'viewed', 2)]),
    [event('c', 'signed', 3)],
  )

  it('numbers and links events, and an untouched chain checks out', () => {
    expect(chain.map((e) => e.sequence)).toEqual([1, 2, 3])
    expect(chain[0]?.prevHash).toBeNull()
    expect(chain[1]?.prevHash).toBe(chain[0]?.rowHash)
    expect(verifyAuditChain(chain)).toEqual({ ok: true, chainedEvents: 3 })
  })

  it('catches an edited, removed or reordered event', () => {
    const [first, second, third] = chain as [ChainedEvent, ChainedEvent, ChainedEvent]
    const edited = chain.map((e, i) => (i === 1 ? { ...e, event: 'signed' } : e))
    expect(verifyAuditChain(edited)).toMatchObject({ ok: false, brokenAtSequence: 2 })
    expect(verifyAuditChain([first, third])).toMatchObject({
      ok: false,
      brokenAtSequence: 2,
    })
    expect(verifyAuditChain([second, first, third])).toMatchObject({
      ok: false,
      brokenAtSequence: 1,
    })
  })
})
