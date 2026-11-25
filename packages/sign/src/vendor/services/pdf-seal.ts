// Copied from SignuDoc (MIT, Copyright (c) 2026 Nyllon Software); see ../LICENSE-SignuDoc.
import { createHash, createSign, randomBytes } from "node:crypto";

import { SignPdf } from "@signpdf/signpdf";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { Signer, SUBFILTER_ETSI_CADES_DETACHED } from "@signpdf/utils";
import forge from "node-forge";
import type { PDFDocument } from "pdf-lib";

import { truncateToWholeCharacters } from "../text-truncate.ts";
import { children, elementBytes, readTlv } from "./der.ts";

// A PAdES baseline (B-B, or B-T with a timestamp) seal on a finished PDF.
//
// The seal is a CMS signature over the whole file, made with this install's
// own key. Any PDF reader then shows whether the file was changed after it
// was sealed. With the install's self-made certificate a reader reports the
// signer's identity as unknown, but still reports the document as unchanged;
// an organization that wants its name verified can supply a certificate from
// a certificate authority instead (SEAL_P12_BASE64).

const asn1 = forge.asn1;
const OID = {
  contentType: "1.2.840.113549.1.9.3",
  data: "1.2.840.113549.1.7.1",
  messageDigest: "1.2.840.113549.1.9.4",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha256WithRsa: "1.2.840.113549.1.1.11",
  signedData: "1.2.840.113549.1.7.2",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  timeStampToken: "1.2.840.113549.1.9.16.2.14",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
} as const;

// Room for the CMS structure, a certificate chain and a timestamp token.
const SIGNATURE_PLACEHOLDER_BYTES = 24_576;
const TIMESTAMP_TIMEOUT_MS = 10_000;

export type SealIdentity = {
  /** The signing certificate first, then any chain above it, as PEM. */
  certificateChainPem: string[];
  privateKeyPem: string;
};

export type SealOptions = {
  /** Hotsauce: the product name written into the seal (white-label). */
  appName?: string;
  contactInfo?: string;
  location?: string;
  name: string;
  reason: string;
  signingTime?: Date;
  /** An RFC 3161 time-stamping service. Without one the seal is PAdES B-B. */
  timestampUrl?: string | null;
};

export class PdfSealError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PdfSealError";
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function oid(value: string) {
  return asn1.create(
    asn1.Class.UNIVERSAL,
    asn1.Type.OID,
    false,
    asn1.oidToDer(value).getBytes(),
  );
}

function seq(values: forge.asn1.Asn1[]) {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, values);
}

function set(values: forge.asn1.Asn1[]) {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, values);
}

function octets(binary: string) {
  return asn1.create(
    asn1.Class.UNIVERSAL,
    asn1.Type.OCTETSTRING,
    false,
    binary,
  );
}

function integer(binary: string) {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, binary);
}

function nullValue() {
  return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, "");
}

function contextTag(tag: number, values: forge.asn1.Asn1[]) {
  return asn1.create(asn1.Class.CONTEXT_SPECIFIC, tag, true, values);
}

function attribute(type: string, value: forge.asn1.Asn1) {
  return seq([oid(type), set([value])]);
}

function toBinary(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("binary");
}

function derOf(value: forge.asn1.Asn1): string {
  return asn1.toDer(value).getBytes();
}

/** Builds the detached CMS SignedData that goes into the PDF. */
/** The issuer Name exactly as encoded in the certificate (RFC 5280 4.1). */
function certificateIssuerAsn1(certificate: forge.asn1.Asn1): forge.asn1.Asn1 {
  const tbs = (certificate.value as forge.asn1.Asn1[])[0]!;
  const fields = tbs.value as forge.asn1.Asn1[];
  // [0] version is optional; after it come serial, signature, issuer.
  const offset =
    fields[0]!.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;

  return fields[offset + 2]!;
}

export async function buildCadesSignature(
  content: Uint8Array,
  identity: SealIdentity,
  { timestampUrl }: { timestampUrl?: string | null } = {},
): Promise<Uint8Array> {
  if (identity.certificateChainPem.length === 0) {
    throw new PdfSealError("The seal identity has no certificate.");
  }

  // The certificates as they were issued, byte for byte. Re-encoding them
  // through forge's parsed form can change non-ASCII names, which would
  // break both the certificate and the issuer match below.
  const certificateAsn1s = identity.certificateChainPem.map((pem) =>
    forge.asn1.fromDer(forge.pem.decode(pem)[0]!.body),
  );
  const signingCertificateAsn1 = certificateAsn1s[0]!;
  const signingCertificate = forge.pki.certificateFromAsn1(
    signingCertificateAsn1,
  );
  const signingCertificateDer = derOf(signingCertificateAsn1);
  const contentDigest = createHash("sha256").update(content).digest();
  const certificateDigest = createHash("sha256")
    .update(Buffer.from(signingCertificateDer, "binary"))
    .digest();
  const signedAttributes = [
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.messageDigest, octets(contentDigest.toString("binary"))),
    // ESSCertIDv2 with the default hash (SHA-256), so no algorithm is named.
    attribute(
      OID.signingCertificateV2,
      seq([seq([seq([octets(certificateDigest.toString("binary"))])])]),
    ),
  ];
  // The signature covers the attributes encoded as a SET (RFC 5652 5.4).
  const signedAttributesDer = derOf(set(signedAttributes));
  const signer = createSign("sha256");

  signer.update(Buffer.from(signedAttributesDer, "binary"));

  const signatureValue = signer.sign(identity.privateKeyPem);
  const unsignedAttributes: forge.asn1.Asn1[] = [];

  if (timestampUrl) {
    const token = await requestTimestampToken(signatureValue, timestampUrl);

    unsignedAttributes.push(attribute(OID.timeStampToken, token));
  }

  const issuerAndSerial = seq([
    certificateIssuerAsn1(signingCertificateAsn1),
    integer(forge.util.hexToBytes(signingCertificate.serialNumber)),
  ]);
  const signerInfo = seq([
    integer(String.fromCharCode(1)),
    issuerAndSerial,
    seq([oid(OID.sha256), nullValue()]),
    contextTag(0, signedAttributes),
    seq([oid(OID.sha256WithRsa), nullValue()]),
    octets(signatureValue.toString("binary")),
    ...(unsignedAttributes.length > 0
      ? [contextTag(1, unsignedAttributes)]
      : []),
  ]);
  const signedData = seq([
    integer(String.fromCharCode(1)),
    set([seq([oid(OID.sha256), nullValue()])]),
    seq([oid(OID.data)]),
    contextTag(0, certificateAsn1s),
    set([signerInfo]),
  ]);
  const contentInfo = seq([oid(OID.signedData), contextTag(0, [signedData])]);

  return new Uint8Array(Buffer.from(derOf(contentInfo), "binary"));
}

/**
 * Asks an RFC 3161 service to timestamp the signature value, and returns the
 * token (a CMS ContentInfo) to store beside it.
 */
function stripLeadingZeros(bytes: string): string {
  return bytes.replace(/^\x00+/, "");
}

/**
 * Checks that a token answers this request: its TSTInfo carries the hash of
 * this signature and this request's nonce (RFC 3161 2.4.2). The token's own
 * signature is the time-stamping service's, and PDF readers check it.
 */
function assertTokenMatchesRequest(
  token: forge.asn1.Asn1,
  imprint: Buffer,
  nonce: Buffer,
) {
  try {
    // ContentInfo { contentType, [0] SignedData }
    const signedData = (
      (token.value as forge.asn1.Asn1[])[1]!.value as forge.asn1.Asn1[]
    )[0]!;
    // SignedData { version, digestAlgorithms, encapContentInfo, ... }
    const encapsulated = (signedData.value as forge.asn1.Asn1[])[2]!;
    const [contentType, explicitContent] =
      encapsulated.value as forge.asn1.Asn1[];

    if (asn1.derToOid(contentType!.value as string) !== OID.tstInfo) {
      throw new Error("not a TSTInfo");
    }

    const octetString = (explicitContent!.value as forge.asn1.Asn1[])[0]!;
    const tstInfo = asn1.fromDer(octetString.value as string);
    // TSTInfo { version, policy, messageImprint, serialNumber, genTime,
    //           accuracy?, ordering?, nonce?, ... }
    const fields = tstInfo.value as forge.asn1.Asn1[];
    const messageImprint = fields[2]!.value as forge.asn1.Asn1[];
    const hashed = messageImprint[1]!.value as string;
    const tokenNonce = fields
      .slice(5)
      .find(
        (field) =>
          field.tagClass === asn1.Class.UNIVERSAL &&
          field.type === asn1.Type.INTEGER,
      )?.value as string | undefined;

    if (
      hashed !== imprint.toString("binary") ||
      tokenNonce === undefined ||
      stripLeadingZeros(tokenNonce) !==
        stripLeadingZeros(nonce.toString("binary"))
    ) {
      throw new Error("imprint or nonce differs");
    }
  } catch (error) {
    throw new PdfSealError(
      "The time-stamping service sent a token that does not answer this request.",
      { cause: error },
    );
  }
}

async function requestTimestampToken(
  signatureValue: Buffer,
  timestampUrl: string,
): Promise<forge.asn1.Asn1> {
  const imprint = createHash("sha256").update(signatureValue).digest();

  return (await fetchTimestampToken(imprint, timestampUrl)).asn1;
}

/**
 * An RFC 3161 token for a SHA-256 digest, byte for byte as the service sent
 * it, for a document timestamp.
 */
export async function requestDocumentTimestamp(
  digest: Buffer,
  timestampUrl: string,
): Promise<Buffer> {
  return (await fetchTimestampToken(digest, timestampUrl)).der;
}

async function fetchTimestampToken(
  imprint: Buffer,
  timestampUrl: string,
): Promise<{ asn1: forge.asn1.Asn1; der: Buffer }> {
  const nonce = randomBytes(8);

  nonce[0] = nonce[0]! & 0x7f;

  const request = seq([
    integer(String.fromCharCode(1)),
    seq([
      seq([oid(OID.sha256), nullValue()]),
      octets(imprint.toString("binary")),
    ]),
    integer(nonce.toString("binary")),
    asn1.create(
      asn1.Class.UNIVERSAL,
      asn1.Type.BOOLEAN,
      false,
      String.fromCharCode(0xff),
    ),
  ]);
  let response: Response;

  try {
    response = await fetch(timestampUrl, {
      body: Buffer.from(derOf(request), "binary"),
      headers: { "content-type": "application/timestamp-query" },
      method: "POST",
      signal: AbortSignal.timeout(TIMESTAMP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new PdfSealError("The time-stamping service could not be reached.", {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new PdfSealError(
      `The time-stamping service answered ${String(response.status)}.`,
    );
  }

  const body = Buffer.from(await response.arrayBuffer());
  let parsed: forge.asn1.Asn1;
  let tokenDer: Buffer | null = null;

  try {
    parsed = asn1.fromDer(body.toString("binary"));

    const [, token] = children(body, readTlv(body));

    tokenDer = token ? elementBytes(body, token) : null;
  } catch (error) {
    throw new PdfSealError(
      "The time-stamping service sent an unreadable answer.",
      {
        cause: error,
      },
    );
  }

  // TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken OPTIONAL }
  const parts = parsed.value as forge.asn1.Asn1[];
  const statusInfo = parts[0]?.value as forge.asn1.Asn1[] | undefined;
  const statusValue = statusInfo?.[0]?.value;
  const status =
    typeof statusValue === "string"
      ? statusValue.charCodeAt(statusValue.length - 1)
      : -1;

  // 0 = granted, 1 = granted with modifications.
  if ((status !== 0 && status !== 1) || !parts[1] || !tokenDer) {
    throw new PdfSealError("The time-stamping service refused the request.");
  }

  assertTokenMatchesRequest(parts[1], imprint, nonce);

  return { asn1: parts[1], der: tokenDer };
}

class CadesSigner extends Signer {
  readonly identity: SealIdentity;
  readonly timestampUrl: string | null;

  constructor(identity: SealIdentity, timestampUrl: string | null) {
    super();
    this.identity = identity;
    this.timestampUrl = timestampUrl;
  }

  async sign(content: Buffer): Promise<Buffer> {
    return Buffer.from(
      await buildCadesSignature(new Uint8Array(content), this.identity, {
        timestampUrl: this.timestampUrl,
      }),
    );
  }
}

/**
 * Saves the document with a seal over the whole file. Nothing may change the
 * document after this, or the seal no longer verifies.
 */
export async function saveSealedPdf(
  pdfDocument: PDFDocument,
  identity: SealIdentity,
  options: SealOptions,
): Promise<Uint8Array> {
  const signingTime = options.signingTime ?? new Date();

  pdflibAddPlaceholder({
    appName: options.appName ?? "Hotsauce",
    contactInfo: options.contactInfo ?? "",
    location: options.location ?? "",
    name: options.name,
    pdfDoc: pdfDocument,
    reason: options.reason,
    signatureLength: SIGNATURE_PLACEHOLDER_BYTES,
    signingTime,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
  });

  const unsigned = await pdfDocument.save({ useObjectStreams: false });
  const signed = await new SignPdf().sign(
    Buffer.from(unsigned),
    new CadesSigner(identity, options.timestampUrl ?? null),
    signingTime,
  );

  return new Uint8Array(signed);
}

export type GeneratedSealIdentity = SealIdentity & { certificatePem: string };

/**
 * A certificate made and signed by the install itself. It proves only that
 * the holder of this key sealed the file, which is what tamper evidence needs.
 */
export function createSelfSignedSealIdentity({
  commonName,
  organization,
  privateKeyPem,
  publicKeyPem,
  validYears = 20,
}: {
  commonName: string;
  organization?: string | null;
  privateKeyPem: string;
  publicKeyPem: string;
  validYears?: number;
}): GeneratedSealIdentity {
  const certificate = forge.pki.createCertificate();
  const now = new Date();
  const notAfter = new Date(now);

  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + validYears);

  const serial = randomBytes(16);

  serial[0] = serial[0]! & 0x7f;
  certificate.serialNumber = serial.toString("hex");
  certificate.publicKey = forge.pki.publicKeyFromPem(publicKeyPem);
  certificate.validity.notBefore = now;
  certificate.validity.notAfter = notAfter;

  const subject = [
    { name: "commonName", value: truncateToWholeCharacters(commonName, 64) },
    ...(organization
      ? [
          {
            name: "organizationName",
            value: truncateToWholeCharacters(organization, 64),
          },
        ]
      : []),
  ];

  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.setExtensions([
    { cA: false, critical: true, name: "basicConstraints" },
    {
      critical: true,
      digitalSignature: true,
      name: "keyUsage",
      nonRepudiation: true,
    },
    { name: "subjectKeyIdentifier" },
  ]);
  certificate.sign(
    forge.pki.privateKeyFromPem(privateKeyPem),
    forge.md.sha256.create(),
  );

  const certificatePem = forge.pki.certificateToPem(certificate);

  return {
    certificateChainPem: [certificatePem],
    certificatePem,
    privateKeyPem,
  };
}

/** Reads a PKCS#12 bundle (from a certificate authority) into an identity. */
export function sealIdentityFromPkcs12(
  p12: Uint8Array,
  passphrase: string,
): SealIdentity {
  const parsed = forge.pkcs12.pkcs12FromAsn1(
    asn1.fromDer(toBinary(p12)),
    false,
    passphrase,
  );
  const keyBag =
    parsed.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ]?.[0] ??
    parsed.getBags({ bagType: forge.pki.oids.keyBag })[
      forge.pki.oids.keyBag
    ]?.[0];
  const certificates = (
    parsed.getBags({ bagType: forge.pki.oids.certBag })[
      forge.pki.oids.certBag
    ] ?? []
  )
    .map((bag) => bag.cert)
    .filter((cert): cert is forge.pki.Certificate => Boolean(cert));
  const privateKey = keyBag?.key as forge.pki.rsa.PrivateKey | undefined;

  if (!privateKey || certificates.length === 0) {
    throw new PdfSealError(
      "SEAL_P12_BASE64 must hold one private key and its certificate.",
    );
  }

  const matching = certificates.find((certificate) => {
    const publicKey = certificate.publicKey as forge.pki.rsa.PublicKey;

    return (
      publicKey.n.compareTo(privateKey.n) === 0 &&
      publicKey.e.compareTo(privateKey.e) === 0
    );
  });

  if (!matching) {
    throw new PdfSealError(
      "No certificate in SEAL_P12_BASE64 matches its private key.",
    );
  }

  return {
    certificateChainPem: [
      matching,
      ...certificates.filter((certificate) => certificate !== matching),
    ].map((certificate) => forge.pki.certificateToPem(certificate)),
    privateKeyPem: forge.pki.privateKeyToPem(privateKey),
  };
}

export const SEAL_TEST_OIDS = OID;
