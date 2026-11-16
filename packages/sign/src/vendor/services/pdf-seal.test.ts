import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { promisify } from "node:util";

import forge from "node-forge";
import { PDFDocument, StandardFonts } from "pdf-lib";

import {
  buildCadesSignature,
  createSelfSignedSealIdentity,
  saveSealedPdf,
  SEAL_TEST_OIDS,
  sealIdentityFromPkcs12,
  type SealIdentity,
} from "./pdf-seal.ts";

const run = promisify(execFile);

function makeIdentity(): SealIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });

  return createSelfSignedSealIdentity({
    commonName: "Test seal",
    organization: "Harbour & Finch",
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
  });
}

async function makePdf(): Promise<PDFDocument> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);

  page.drawText("Signed agreement", {
    font: await pdf.embedFont(StandardFonts.Helvetica),
    x: 72,
    y: 700,
  });

  return pdf;
}

async function hasPdfsig(): Promise<boolean> {
  try {
    await run("pdfsig", ["-v"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The signature sits in a slot of fixed size, filled up with zeros. Where it
 * ends is in its own header: a tag, then its length. Cutting the zeros off
 * the end instead also cuts into a signature that happens to end in one,
 * which about one in sixteen does.
 */
function withoutPadding(slot: Buffer): Buffer {
  const first = slot[1]!;
  const lengthBytes = first < 0x80 ? 0 : first & 0x7f;
  const length = lengthBytes === 0 ? first : slot.readUIntBE(2, lengthBytes);

  return slot.subarray(0, 2 + lengthBytes + length);
}

/** Checks the CMS signature the way a reader would, without poppler. */
function verifyByteRange(sealed: Uint8Array) {
  const text = Buffer.from(sealed).toString("latin1");
  const match = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(
    text,
  );

  assert.ok(match, "the seal has a byte range");

  const [a, b, c, d] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const signedContent = Buffer.concat([
    Buffer.from(sealed.subarray(a, a + b)),
    Buffer.from(sealed.subarray(c, c + d)),
  ]);
  const cms = forge.asn1.fromDer(
    withoutPadding(Buffer.from(text.slice(a + b + 1, c - 1), "hex")).toString(
      "binary",
    ),
  );
  const message = forge.pkcs7.messageFromAsn1(cms) as unknown as {
    rawCapture: { authenticatedAttributes: forge.asn1.Asn1[] };
  };
  const digestAttribute = message.rawCapture.authenticatedAttributes.find(
    (attribute) =>
      forge.asn1.derToOid(
        (attribute.value as forge.asn1.Asn1[])[0]!.value as string,
      ) === SEAL_TEST_OIDS.messageDigest,
  );
  const digest = (
    (digestAttribute!.value as forge.asn1.Asn1[])[1]!.value as forge.asn1.Asn1[]
  )[0]!.value as string;

  assert.equal(
    Buffer.from(digest, "binary").toString("hex"),
    forge.md.sha256
      .create()
      .update(signedContent.toString("binary"))
      .digest()
      .toHex(),
  );

  return { a, b, c, d };
}

test("a sealed PDF verifies, and any change to it is detected", async () => {
  const identity = makeIdentity();
  const sealed = await saveSealedPdf(await makePdf(), identity, {
    name: "SignuDoc",
    reason: "Signed with SignuDoc",
  });

  verifyByteRange(sealed);

  if (!(await hasPdfsig())) {
    console.info("pdfsig is not installed; skipped the poppler check");
    return;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "seal-"));

  try {
    const original = path.join(directory, "sealed.pdf");

    await writeFile(original, sealed);

    const { stdout } = await run("pdfsig", ["-nocert", original]);

    assert.match(stdout, /Signature Validation: Signature is Valid\./);
    assert.match(stdout, /Signature Type: ETSI\.CAdES\.detached/);
    assert.match(stdout, /Total document signed/);

    // Change one byte of the page text and the seal must fail.
    const tampered = Buffer.from(sealed);
    const position = tampered.indexOf("Signed agreement");
    const changed = path.join(directory, "tampered.pdf");

    if (position === -1) {
      // The text sits in a compressed stream; change a byte in the header
      // comment instead, which is inside the signed range too.
      tampered[10] = tampered[10] === 0x41 ? 0x42 : 0x41;
    } else {
      tampered[position] = 0x58;
    }

    await writeFile(changed, tampered);

    const result = await run("pdfsig", ["-nocert", changed]).catch(
      (error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }),
    );

    assert.doesNotMatch(
      result.stdout,
      /Signature Validation: Signature is Valid\./,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

// A stand-in time-stamping service. It answers "granted" with a token
// shaped like a real one (ContentInfo > SignedData > TSTInfo) that echoes
// the request's hash and nonce, or a wrong hash when told to. The token's
// own signature is not made: readers check that, not this code.
async function withTimestampServer(
  { wrongImprint = false }: { wrongImprint?: boolean },
  run: (url: string, seen: { contentType?: string }) => Promise<void>,
) {
  const a = forge.asn1;
  const seq = (value: forge.asn1.Asn1[]) =>
    a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, value);
  const oid = (value: string) =>
    a.create(
      a.Class.UNIVERSAL,
      a.Type.OID,
      false,
      a.oidToDer(value).getBytes(),
    );
  const integer = (value: string) =>
    a.create(a.Class.UNIVERSAL, a.Type.INTEGER, false, value);
  const seen: { contentType?: string } = {};
  const server = createServer((request, response) => {
    seen.contentType = request.headers["content-type"];

    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      // TimeStampReq { version, messageImprint, nonce, certReq }
      const query = a.fromDer(Buffer.concat(chunks).toString("binary"));
      const [, messageImprint, nonce] = query.value as forge.asn1.Asn1[];
      const imprintFields = messageImprint!.value as forge.asn1.Asn1[];
      const hashed = wrongImprint
        ? "x".repeat(32)
        : (imprintFields[1]!.value as string);
      const tstInfo = seq([
        integer(String.fromCharCode(1)),
        oid("1.2.3.4"),
        seq([
          imprintFields[0]!,
          a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, hashed),
        ]),
        integer(String.fromCharCode(7)),
        a.create(
          a.Class.UNIVERSAL,
          a.Type.GENERALIZEDTIME,
          false,
          "20261112120000Z",
        ),
        integer(nonce!.value as string),
      ]);
      const token = seq([
        oid(SEAL_TEST_OIDS.signedData),
        a.create(a.Class.CONTEXT_SPECIFIC, 0, true, [
          seq([
            integer(String.fromCharCode(3)),
            a.create(a.Class.UNIVERSAL, a.Type.SET, true, []),
            seq([
              oid(SEAL_TEST_OIDS.tstInfo),
              a.create(a.Class.CONTEXT_SPECIFIC, 0, true, [
                a.create(
                  a.Class.UNIVERSAL,
                  a.Type.OCTETSTRING,
                  false,
                  a.toDer(tstInfo).getBytes(),
                ),
              ]),
            ]),
          ]),
        ]),
      ]);
      const answer = seq([seq([integer(String.fromCharCode(0))]), token]);

      response.writeHead(200, {
        "content-type": "application/timestamp-reply",
      });
      response.end(Buffer.from(a.toDer(answer).getBytes(), "binary"));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    await run(`http://127.0.0.1:${String(port)}/`, seen);
  } finally {
    server.close();
  }
}

test("a timestamp token from the service is stored with the signature", async () => {
  const identity = makeIdentity();

  await withTimestampServer({}, async (timestampUrl, seen) => {
    const cms = await buildCadesSignature(new Uint8Array([1, 2, 3]), identity, {
      timestampUrl,
    });
    const der = Buffer.from(cms).toString("binary");

    assert.equal(seen.contentType, "application/timestamp-query");
    assert.ok(
      der.includes(
        forge.asn1.oidToDer(SEAL_TEST_OIDS.timeStampToken).getBytes(),
      ),
      "the token attribute is present",
    );
  });
});

test("a timestamp token for some other request is refused", async () => {
  const identity = makeIdentity();

  await withTimestampServer({ wrongImprint: true }, async (timestampUrl) => {
    await assert.rejects(
      buildCadesSignature(new Uint8Array([1, 2, 3]), identity, {
        timestampUrl,
      }),
      /does not answer this request/,
    );
  });
});

test("a PKCS#12 bundle from a certificate authority can be used", () => {
  const identity = makeIdentity();
  const key = forge.pki.privateKeyFromPem(identity.privateKeyPem);
  const certificate = forge.pki.certificateFromPem(
    identity.certificateChainPem[0]!,
  );
  const p12 = forge.pkcs12.toPkcs12Asn1(key, [certificate], "secret", {
    algorithm: "3des",
  });
  const bytes = new Uint8Array(
    Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary"),
  );
  const parsed = sealIdentityFromPkcs12(bytes, "secret");

  assert.equal(parsed.certificateChainPem.length, 1);
  assert.match(parsed.privateKeyPem, /PRIVATE KEY/);
  assert.throws(() => sealIdentityFromPkcs12(bytes, "wrong"));
});
