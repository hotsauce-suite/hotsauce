// Hotsauce's face on SignuDoc's engine (./vendor). Everything here takes bytes and records and
// returns bytes: no database, no storage, no network. Hotsauce's server keeps the envelope in Git
// and the PDFs in Files, and hands them in.
import { generateKeyPairSync } from 'node:crypto'
import type { PDFDocument } from 'pdf-lib'
import type { AuditEventRecord, EnvelopeRecord } from './vendor/schemas/envelope.ts'
import type { FieldRecord } from './vendor/schemas/field.ts'
import type { SignerRecord } from './vendor/schemas/signer.ts'
import {
  type CertificateCopyRecipient,
  type PdfSealer,
  renderEnvelopeCertificatePdf,
  renderFinalizedEnvelopePdf,
  type SealPurpose,
} from './vendor/services/pdf-finalize.ts'
import {
  createSelfSignedSealIdentity,
  type SealIdentity,
  saveSealedPdf,
  sha256Hex,
} from './vendor/services/pdf-seal.ts'

export type { AuditEventRecord, EnvelopeRecord } from './vendor/schemas/envelope.ts'
export type { FieldRecord } from './vendor/schemas/field.ts'
export type { SignerRecord } from './vendor/schemas/signer.ts'
export {
  type AuditChainCheck,
  type ChainedEvent,
  type ChainedFields,
  chainAuditEvents,
  computeAuditRowHash as auditRowHash,
  verifyAuditChain,
} from './vendor/services/audit.ts'
export { SourceDocumentChangedError } from './vendor/services/pdf-finalize.ts'
export { PdfSealError, type SealIdentity, sha256Hex } from './vendor/services/pdf-seal.ts'
export type { CertificateCopyRecipient, PdfSealer, SealPurpose }

/** R1: a fresh RSA key and a certificate the install signs itself, valid 20 years. */
export function createSealIdentity({
  commonName,
  organization,
}: {
  commonName: string
  organization?: string | null
}): SealIdentity & { certificatePem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' },
  })
  return createSelfSignedSealIdentity({
    commonName,
    organization: organization ?? null,
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
  })
}

/** What the seal says about who sealed it, shown in a PDF reader's signature panel. */
export type SealLabel = {
  /** The organization or install, e.g. "Haven". */
  name: string
  /** The product name people see (white-label), e.g. "Hotsauce". */
  productName: string
  /** Where to write about a document, if the install has one. */
  contactInfo?: string | null
}

/**
 * R2: a sealer that saves a document with one PAdES (ETSI.CAdES.detached) signature over the
 * whole file. Any later change to the file makes the signature check fail.
 */
export function makeSealer(identity: SealIdentity, label: SealLabel): PdfSealer {
  return (document: PDFDocument, purpose: SealPurpose) =>
    saveSealedPdf(document, identity, {
      appName: label.productName,
      contactInfo: label.contactInfo ?? '',
      name: label.name,
      reason:
        purpose === 'signed-document'
          ? `Signed with ${label.productName}; sealed so that later changes are detectable`
          : `${label.productName} audit certificate`,
    })
}

/**
 * R3: stamps every filled field onto the source PDF, flattens any form and seals it. Refuses
 * (SourceDocumentChangedError) a source whose SHA-256 is not the envelope's `sourcePdfHash`.
 * `images` holds the PNG of each drawn signature by its field's `imageKey`.
 */
export async function renderSignedPdf(
  input: {
    source: Uint8Array
    envelope: EnvelopeRecord
    signers: SignerRecord[]
    fields: FieldRecord[]
    images?: ReadonlyMap<string, Uint8Array>
    completedAt?: number
  },
  seal: PdfSealer,
): Promise<Uint8Array> {
  const sourceKey = '\u0000source'
  const objects = new Map<string, Uint8Array>(input.images ?? [])
  objects.set(sourceKey, input.source)
  return renderFinalizedEnvelopePdf(
    {
      auditEvents: [],
      completedAt: input.completedAt ?? Math.floor(Date.now() / 1000),
      envelope: input.envelope,
      fields: input.fields,
      signers: input.signers,
      sourcePdfKey: sourceKey,
    },
    {
      seal,
      storageService: {
        async getObject(key) {
          const body = objects.get(key)
          if (!body) throw new Error(`The engine asked for ${key}, which was not handed in.`)
          return { body }
        },
      },
    },
  )
}

/**
 * R4: a sealed audit certificate for a finished (completed, declined or voided) envelope.
 * `forRecipients` hides IP addresses and browsers, for the copy sent to signers.
 */
export function renderCertificate(
  input: {
    envelope: EnvelopeRecord
    signers: SignerRecord[]
    auditEvents: AuditEventRecord[]
    signedPdfSha256?: string | null
    copyRecipients?: readonly CertificateCopyRecipient[]
    forRecipients?: boolean
    /** The product name in the PDF's Producer field (white-label). */
    productName?: string
  },
  seal: PdfSealer,
): Promise<Uint8Array> {
  return renderEnvelopeCertificatePdf(
    {
      ...(input.productName ? { productName: input.productName } : {}),
      auditEvents: input.auditEvents,
      envelope: input.envelope,
      signers: input.signers,
      ...(input.signedPdfSha256 !== undefined ? { signedPdfSha256: input.signedPdfSha256 } : {}),
      ...(input.copyRecipients ? { copyRecipients: input.copyRecipients } : {}),
      ...(input.forRecipients ? { redactForRecipients: true } : {}),
    },
    { seal },
  )
}

/** The SHA-256 a PDF must have to be the one an envelope was sent with. */
export const pdfFingerprint = sha256Hex
