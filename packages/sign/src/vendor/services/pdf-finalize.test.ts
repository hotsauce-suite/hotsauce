// Copied from SignuDoc (MIT, Copyright (c) 2026 Nyllon Software); see ../LICENSE-SignuDoc.
import assert from "node:assert/strict";
import { test } from "vitest";

import { PDFDocument } from "pdf-lib";

import type { AuditEventRecord, EnvelopeRecord } from "../schemas/envelope.ts";
import type { FieldRecord } from "../schemas/field.ts";
import type { SignerRecord } from "../schemas/signer.ts";
import {
  computeAuditFingerprint,
  findTypedValueTooLongForField,
  renderEnvelopeCertificatePdf,
  renderFinalizedEnvelopePdf,
  wrapFieldText,
} from "./pdf-finalize.ts";
import { embedTextFaces } from "./pdf-fonts.ts";
import { sha256Hex } from "./pdf-seal.ts";
import type { StorageService } from "./pdf-finalize.ts";

// Names and values outside Windows-1252 used to fail the whole signing with
// "WinAnsi cannot encode". These tests run the two renderers on such text.

// Hotsauce leaves out the CJK font (docs/PLAN-sign.md R6), so these use scripts it draws.
const TITLE = "Umowa o dzieło – Łódź / Σύμβαση έργου";
const SIGNER_NAME = "Łukasz Żółć";
const SECOND_SIGNER_NAME = "Ελένη Παπαδοπούλου";
const TEXT_VALUE = "Санкт-Петербург, Hà Nội";

async function extractText(pdfBytes: Uint8Array): Promise<string> {
  // Hotsauce: pdf.js through unpdf, which the server already uses.
  const { getDocumentProxy } = await import("unpdf");
  const document = await getDocumentProxy(new Uint8Array(pdfBytes));
  const parts: string[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();

    parts.push(
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" "),
    );
  }

  await document.cleanup();

  return parts.join("\n");
}

async function makeFixture() {
  const sourceDocument = await PDFDocument.create();

  sourceDocument.addPage([612, 792]);

  const sourcePdf = await sourceDocument.save();
  const now = 1_800_000_000;
  const envelope: EnvelopeRecord = {
    completedAt: now,
    createdAt: now - 500,
    declinedAt: null,
    evidenceKey: null,
    id: "envelope-1",
    pageCount: 1,
    sentAt: now - 400,
    signedPdfKey: null,
    sourcePdfFilename: "umowa.pdf",
    sourcePdfHash: sha256Hex(sourcePdf),
    sourcePdfKey: "source.pdf",
    sourcePdfSizeBytes: sourcePdf.byteLength,
    status: "completed",
    title: TITLE,
    updatedAt: now,
    userId: "user-1",
    voidedAt: null,
  };
  const signers: SignerRecord[] = [
    {
      createdAt: now - 500,
      email: "lukasz@example.com",
      id: "signer-1",
      name: SIGNER_NAME,
      signedAt: now - 100,
      signOrder: 1,
      status: "signed",
      updatedAt: now - 100,
    },
    {
      createdAt: now - 500,
      email: "yamada@example.com",
      id: "signer-2",
      name: SECOND_SIGNER_NAME,
      signedAt: now,
      signOrder: 2,
      status: "signed",
      updatedAt: now,
    },
  ];
  const baseField = {
    createdAt: now - 500,
    envelopeId: envelope.id,
    height: 0.05,
    page: 1,
    required: true,
    submittedAt: now - 100,
    updatedAt: now - 100,
    width: 0.4,
    x: 0.1,
  };
  const fields: FieldRecord[] = [
    {
      ...baseField,
      id: "field-1",
      inputMethod: "typed",
      signerId: "signer-1",
      type: "signature",
      value: SIGNER_NAME,
      y: 0.1,
    },
    {
      ...baseField,
      id: "field-2",
      inputMethod: "typed",
      signerId: "signer-2",
      type: "signature",
      value: SECOND_SIGNER_NAME,
      y: 0.2,
    },
    {
      ...baseField,
      id: "field-3",
      signerId: "signer-1",
      type: "text",
      value: TEXT_VALUE,
      y: 0.3,
    },
    {
      ...baseField,
      id: "field-4",
      signerId: "signer-1",
      type: "text",
      value: "first line\nsecond line",
      y: 0.4,
    },
  ];
  const auditEvents: AuditEventRecord[] = [
    {
      actorEmail: "lukasz@example.com",
      actorType: "signer",
      createdAt: now - 100,
      envelopeId: envelope.id,
      event: "signed",
      id: "event-1",
      ipAddress: "203.0.113.7",
      metadata: {
        signerEmail: "lukasz@example.com",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
      userAgent: "Mozilla/5.0 (Тест)",
    },
  ];
  const storageService = {
    getObject: async () => ({
      body: sourcePdf,
      contentLength: sourcePdf.byteLength,
      contentType: "application/pdf",
    }),
  } as unknown as StorageService;

  return { auditEvents, envelope, fields, signers, storageService };
}

const saveUnsealed = (pdfDocument: PDFDocument) => pdfDocument.save();

test("the signed PDF stamps values in any of the supported scripts", async () => {
  const fixture = await makeFixture();
  const pdfBytes = await renderFinalizedEnvelopePdf(
    {
      auditEvents: fixture.auditEvents,
      completedAt: fixture.envelope.completedAt!,
      envelope: fixture.envelope,
      fields: fixture.fields,
      signers: fixture.signers,
      pages: [],
      sourcePdfKey: fixture.envelope.sourcePdfKey,
    },
    { seal: saveUnsealed, storageService: fixture.storageService },
  );
  const text = (await extractText(pdfBytes)).replace(/\s+/g, " ");

  assert.ok(text.includes(SIGNER_NAME));
  // Hotsauce: the Greek name is typed in the script font, which has no Greek,
  // so each letter falls back to Noto Sans and pdf.js reads gaps between runs.
  assert.ok(
    text.replace(/\s/g, "").includes(SECOND_SIGNER_NAME.replace(/\s/g, "")),
  );
  assert.ok(text.includes(TEXT_VALUE));
  // A line break in a value used to fail too. It is drawn as a space.
  assert.ok(text.includes("first line second line"));
  // Only the glyphs in use are embedded, next to the script font.
  assert.ok(
    pdfBytes.byteLength < 500_000,
    `signed PDF is ${String(pdfBytes.byteLength)} bytes`,
  );
});

test("the certificate prints names, titles and browser strings as they are", async () => {
  const fixture = await makeFixture();
  const pdfBytes = await renderEnvelopeCertificatePdf(
    {
      auditEvents: fixture.auditEvents,
      envelope: fixture.envelope,
      signers: fixture.signers,
    },
    { seal: saveUnsealed },
  );
  const text = (await extractText(pdfBytes)).replace(/\s+/g, " ");

  assert.ok(text.includes("Łódź"));
  assert.ok(text.includes("Σύμβαση έργου"));
  assert.ok(text.includes(SIGNER_NAME));
  assert.ok(text.includes(SECOND_SIGNER_NAME));
  assert.ok(text.includes("Тест"));
  assert.ok(
    pdfBytes.byteLength < 200_000,
    `certificate is ${String(pdfBytes.byteLength)} bytes`,
  );

  const reloaded = await PDFDocument.load(pdfBytes);

  assert.ok(reloaded.getTitle()?.includes("Σύμβαση έργου"));
});

test("the certificate names the people who were sent a copy", async () => {
  const fixture = await makeFixture();
  const copyRecipients = [
    { email: "zofia@example.com", name: "Zofia Wiśniewska" },
  ];
  const render = (redactForRecipients: boolean) =>
    renderEnvelopeCertificatePdf(
      {
        auditEvents: fixture.auditEvents,
        copyRecipients,
        envelope: fixture.envelope,
        redactForRecipients,
        signers: fixture.signers,
      },
      { seal: saveUnsealed },
    ).then(async (bytes) => (await extractText(bytes)).replace(/\s+/g, " "));
  const full = await render(false);

  assert.ok(full.includes("Copy recipients"));
  assert.ok(full.includes("They did not sign it."));
  assert.ok(full.includes("Zofia Wiśniewska <zofia@example.com>"));

  // The signers' own copy leaves addresses out, as it does for signers.
  const redacted = await render(true);

  assert.ok(redacted.includes("Zofia Wiśniewska"));
  assert.ok(!redacted.includes("zofia@example.com"));

  // No section at all when nobody was sent a copy.
  const without = await renderEnvelopeCertificatePdf(
    {
      auditEvents: fixture.auditEvents,
      envelope: fixture.envelope,
      signers: fixture.signers,
    },
    { seal: saveUnsealed },
  );

  assert.ok(!(await extractText(without)).includes("Copy recipients"));
});

test("recipient certificates omit a correction's previous email", async () => {
  const fixture = await makeFixture();
  const previousEmail = "previous.signer@hide.test";
  const auditEvents: AuditEventRecord[] = [
    {
      actorEmail: "sam@example.test",
      actorType: "sender",
      createdAt: 1_800_000_000 - 50,
      envelopeId: fixture.envelope.id,
      event: "signer_corrected",
      id: "event-correction",
      metadata: {
        previousEmail,
        previousName: SIGNER_NAME,
        signerEmail: "lukasz@example.com",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    ...fixture.auditEvents,
  ];
  const render = (redactForRecipients: boolean) =>
    renderEnvelopeCertificatePdf(
      {
        auditEvents,
        envelope: fixture.envelope,
        redactForRecipients,
        signers: fixture.signers,
      },
      { seal: saveUnsealed },
    ).then(async (bytes) => (await extractText(bytes)).replace(/\s+/g, " "));
  const full = await render(false);
  const redacted = await render(true);

  assert.ok(full.includes(previousEmail));
  assert.ok(full.includes("Signer email corrected from"));
  assert.ok(!redacted.includes(previousEmail));
  assert.ok(redacted.includes("Signer email was corrected"));
});

test("the certificate credits consent recorded after a signer correction", async () => {
  const fixture = await makeFixture();
  const auditEvents: AuditEventRecord[] = [
    {
      actorEmail: "old@example.com",
      actorType: "signer",
      createdAt: 1_799_999_000,
      envelopeId: fixture.envelope.id,
      event: "consented",
      id: "event-old-consent",
      metadata: {
        disclosureVersion: "old-version",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    {
      actorEmail: "sam@example.test",
      actorType: "sender",
      createdAt: 1_799_999_010,
      envelopeId: fixture.envelope.id,
      event: "signer_corrected",
      id: "event-correction",
      metadata: {
        previousEmail: "old@example.com",
        previousName: SIGNER_NAME,
        signerEmail: "lukasz@example.com",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    {
      actorEmail: "lukasz@example.com",
      actorType: "signer",
      createdAt: 1_800_000_050,
      envelopeId: fixture.envelope.id,
      event: "consented",
      id: "event-new-consent",
      metadata: {
        disclosureVersion: "new-version",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    ...fixture.auditEvents,
  ];
  const text = (
    await extractText(
      await renderEnvelopeCertificatePdf(
        {
          auditEvents,
          envelope: fixture.envelope,
          signers: fixture.signers,
        },
        { seal: saveUnsealed },
      ),
    )
  ).replace(/\s+/g, " ");
  const signersSection = text.split("Audit events")[0] ?? "";

  assert.ok(signersSection.includes("disclosure new-version"));
  assert.ok(!signersSection.includes("disclosure old-version"));
});

test("the certificate keeps restored consent after a reversed correction", async () => {
  const fixture = await makeFixture();
  const auditEvents: AuditEventRecord[] = [
    {
      actorEmail: "lukasz@example.com",
      actorType: "signer",
      createdAt: 1_799_999_000,
      envelopeId: fixture.envelope.id,
      event: "consented",
      id: "event-kept-consent",
      metadata: {
        disclosureVersion: "kept-version",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    {
      actorEmail: "sam@example.test",
      actorType: "sender",
      createdAt: 1_799_999_010,
      envelopeId: fixture.envelope.id,
      event: "signer_corrected",
      id: "event-correction",
      metadata: {
        previousEmail: "lukasz@example.com",
        previousName: SIGNER_NAME,
        signerEmail: "temporary@example.com",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    {
      actorEmail: "sam@example.test",
      actorType: "sender",
      createdAt: 1_799_999_020,
      envelopeId: fixture.envelope.id,
      event: "signer_corrected",
      id: "event-reversal",
      metadata: {
        previousEmail: "temporary@example.com",
        previousName: SIGNER_NAME,
        reverted: true,
        signerEmail: "lukasz@example.com",
        signerId: "signer-1",
        signerName: SIGNER_NAME,
      },
    },
    ...fixture.auditEvents,
  ];
  const text = (
    await extractText(
      await renderEnvelopeCertificatePdf(
        {
          auditEvents,
          envelope: fixture.envelope,
          signers: fixture.signers,
        },
        { seal: saveUnsealed },
      ),
    )
  ).replace(/\s+/g, " ");
  const signersSection = text.split("Audit events")[0] ?? "";

  assert.ok(signersSection.includes("disclosure kept-version"));
});

test("numbers and dropdown choices are stamped as text, radio buttons as rings", async () => {
  const fixture = await makeFixture();
  const base = {
    createdAt: 1_800_000_000,
    envelopeId: fixture.envelope.id,
    height: 0.03,
    page: 1,
    required: true,
    signerId: "signer-1",
    submittedAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    width: 0.3,
    x: 0.1,
  };
  const choiceFields: FieldRecord[] = [
    { ...base, id: "number-1", type: "number", value: "1,250.75", y: 0.5 },
    {
      ...base,
      id: "dropdown-1",
      options: ["Tak", "Nie", "Nie wiem"],
      type: "dropdown",
      value: "Nie wiem",
      y: 0.55,
    },
    // An optional dropdown that was left alone: nothing to stamp.
    {
      ...base,
      id: "dropdown-2",
      options: ["One", "Two"],
      required: false,
      submittedAt: null,
      type: "dropdown",
      value: null,
      y: 0.6,
    },
    {
      ...base,
      checked: true,
      groupId: "group-1",
      id: "radio-1",
      label: "Yes",
      type: "radio",
      width: 0.03,
      y: 0.65,
    },
    {
      ...base,
      checked: false,
      groupId: "group-1",
      id: "radio-2",
      label: "No",
      type: "radio",
      width: 0.03,
      y: 0.7,
    },
  ];
  const render = (fields: FieldRecord[]) =>
    renderFinalizedEnvelopePdf(
      {
        auditEvents: fixture.auditEvents,
        completedAt: fixture.envelope.completedAt!,
        envelope: fixture.envelope,
        fields,
        signers: fixture.signers,
        pages: [],
        sourcePdfKey: fixture.envelope.sourcePdfKey,
      },
      { seal: saveUnsealed, storageService: fixture.storageService },
    );
  const pdfBytes = await render([...fixture.fields, ...choiceFields]);
  const text = (await extractText(pdfBytes)).replace(/\s+/g, " ");

  assert.ok(text.includes("1,250.75"));
  assert.ok(text.includes("Nie wiem"));
  // The choices that were not picked are not on the document.
  assert.ok(!text.includes("Tak"));
  assert.ok(!text.includes("One"));

  // The two radio buttons add drawing to the page: two rings and one dot.
  // Without them the same document is smaller.
  const withoutRadios = await render([
    ...fixture.fields,
    ...choiceFields.filter((field) => field.type !== "radio"),
  ]);
  const chosenOnly = await render([
    ...fixture.fields,
    ...choiceFields.filter((field) => field.id !== "radio-2"),
  ]);

  assert.ok(pdfBytes.byteLength > chosenOnly.byteLength);
  assert.ok(chosenOnly.byteLength > withoutRadios.byteLength);
});

// Hotsauce: Great Vibes is a hairline script, so typed signatures read faint on paper
// (Morgan, 2026-11-16). They are drawn filled and outlined in near-black ink instead.
test("typed signatures are drawn in dark, outlined ink", async () => {
  const { decodePDFRawStream, PDFArray, PDFRawStream } = await import("pdf-lib");
  type RawStream = import("pdf-lib").PDFRawStream;
  const fixture = await makeFixture();
  const pdfBytes = await renderFinalizedEnvelopePdf(
    {
      auditEvents: fixture.auditEvents,
      completedAt: fixture.envelope.completedAt!,
      envelope: fixture.envelope,
      fields: fixture.fields.filter((field) => field.id === "field-1"),
      signers: fixture.signers,
      pages: [],
      sourcePdfKey: fixture.envelope.sourcePdfKey,
    },
    { seal: saveUnsealed, storageService: fixture.storageService },
  );
  const page = (await PDFDocument.load(pdfBytes)).getPage(0);
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  const ops = streams
    .map((ref) => page.doc.context.lookup(ref as never))
    .filter((stream): stream is RawStream => stream instanceof PDFRawStream)
    .map((stream) => new TextDecoder().decode(decodePDFRawStream(stream).decode()))
    .join("\n");

  // Fill and stroke (render mode 2) with a visible outline...
  assert.match(ops, /\b2 Tr\b/);
  const width = Number(/([\d.]+) w\b/.exec(ops)?.[1]);
  assert.ok(width >= 0.3, `outline is ${String(width)} pt`);
  // ...in ink no lighter than 10% grey.
  const fill = /([\d.]+) ([\d.]+) ([\d.]+) rg/.exec(ops);
  assert.ok(fill, "no fill colour");
  for (const channel of fill.slice(1)) assert.ok(Number(channel) <= 0.1, `fill ${fill[0]}`);
});

// Audit rows print "time | event | actor". Returns the events in the order
// the certificate lists them.
function certificateEventOrder(text: string): string[] {
  return [...text.matchAll(/UTC \| ([a-z_]+) \|/g)].map((match) => match[1]);
}

async function renderCertificateText(
  envelope: EnvelopeRecord,
  signers: SignerRecord[],
  auditEvents: AuditEventRecord[],
): Promise<string> {
  return (
    await extractText(
      await renderEnvelopeCertificatePdf(
        { auditEvents, envelope, signers },
        { seal: saveUnsealed },
      ),
    )
  ).replace(/\s+/g, " ");
}

test("the last signature is listed before completed in the same second (issue #97)", async () => {
  const fixture = await makeFixture();
  const now = fixture.envelope.completedAt ?? 0;
  // The ids sort after any generated id, so a sort by time then id would
  // put the completed row first.
  const auditEvents: AuditEventRecord[] = [
    {
      actorEmail: "yamada@example.com",
      actorType: "signer",
      createdAt: now,
      envelopeId: fixture.envelope.id,
      event: "signed",
      id: "zz-event-signed",
      metadata: { signerId: "signer-2", signerName: SECOND_SIGNER_NAME },
    },
  ];
  const text = await renderCertificateText(
    fixture.envelope,
    fixture.signers,
    auditEvents,
  );

  assert.deepEqual(certificateEventOrder(text), ["signed", "completed"], text);
});

test("a recorded completed row keeps its place in the recorded order (issue #97)", async () => {
  const fixture = await makeFixture();
  const now = fixture.envelope.completedAt ?? 0;
  const auditEvents: AuditEventRecord[] = [
    {
      actorEmail: "yamada@example.com",
      actorType: "signer",
      createdAt: now,
      envelopeId: fixture.envelope.id,
      event: "signed",
      id: "zz-event-signed",
      metadata: { signerId: "signer-2", signerName: SECOND_SIGNER_NAME },
    },
    {
      actorType: "system",
      createdAt: now,
      envelopeId: fixture.envelope.id,
      event: "completed",
      id: "aa-event-completed",
      metadata: null,
    },
    {
      actorType: "system",
      createdAt: now,
      envelopeId: fixture.envelope.id,
      event: "email_sent",
      id: "00-event-email",
      metadata: null,
    },
  ];
  const text = await renderCertificateText(
    fixture.envelope,
    fixture.signers,
    auditEvents,
  );

  assert.deepEqual(
    certificateEventOrder(text),
    ["signed", "completed", "email_sent"],
    text,
  );
});

test("declined and voided certificates keep same-second events in recorded order (issue #97)", async () => {
  const fixture = await makeFixture();
  const at = 1_799_999_000;
  const sameSecond = (
    event: AuditEventRecord["event"],
    id: string,
  ): AuditEventRecord => ({
    actorType: "system",
    createdAt: at,
    envelopeId: fixture.envelope.id,
    event,
    id,
    metadata: null,
  });

  for (const [status, terminalEvent] of [
    ["declined", "declined"],
    ["voided", "voided"],
  ] as const) {
    const envelope: EnvelopeRecord = {
      ...fixture.envelope,
      completedAt: null,
      declinedAt: status === "declined" ? at : null,
      status,
      voidedAt: status === "voided" ? at : null,
    };
    // Recorded order: sent, signed, the next invitation, then the end. The
    // ids are in reverse, so a sort by id would turn them around.
    const auditEvents = [
      sameSecond("sent", "d-sent"),
      sameSecond("signed", "c-signed"),
      sameSecond("email_sent", "b-email"),
      sameSecond(terminalEvent, "a-end"),
    ];
    const text = await renderCertificateText(
      envelope,
      fixture.signers,
      auditEvents,
    );

    assert.deepEqual(
      certificateEventOrder(text),
      ["sent", "signed", "email_sent", terminalEvent],
      text,
    );
  }
});

// A Text field in the place and size from issue #90: right of centre on a
// US Letter page, 19% of the page wide and 6% high.
const NARROW_FIELD = { height: 0.06, page: 1, width: 0.19, x: 0.69, y: 0.32 };
const LETTER_PAGE = { heightPt: 792, pageNumber: 1, widthPt: 612 };

async function extractTextItems(pdfBytes: Uint8Array) {
  // Hotsauce: pdf.js through unpdf, which the server already uses.
  const { getResolvedPDFJS } = await import("unpdf");
  const pdfjs = await getResolvedPDFJS();
  const task = pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: false,
    verbosity: 0,
  });
  const document = await task.promise;
  const page = await document.getPage(1);
  const content = await page.getTextContent();
  const items = (
    content.items as Array<{
      str?: string;
      transform?: number[];
      width?: number;
    }>
  )
    .filter((item) => item.str && item.transform)
    .map((item) => ({
      left: item.transform![4]!,
      right: item.transform![4]! + (item.width ?? 0),
      text: item.str!,
      y: item.transform![5]!,
    }));

  await task.destroy();

  return items;
}

async function renderOneTextField(value: string) {
  const fixture = await makeFixture();
  const field: FieldRecord = {
    ...NARROW_FIELD,
    createdAt: 1_800_000_000,
    envelopeId: fixture.envelope.id,
    id: "long-text",
    required: true,
    signerId: "signer-1",
    submittedAt: 1_800_000_000,
    type: "text",
    updatedAt: 1_800_000_000,
    value,
  };

  return renderFinalizedEnvelopePdf(
    {
      auditEvents: fixture.auditEvents,
      completedAt: fixture.envelope.completedAt!,
      envelope: fixture.envelope,
      fields: [field],
      pages: [LETTER_PAGE],
      signers: fixture.signers,
      sourcePdfKey: fixture.envelope.sourcePdfKey,
    },
    { seal: saveUnsealed, storageService: fixture.storageService },
  );
}

const LONG_ANSWER = [
  "BEGIN",
  "The tenant agrees to keep the garden tidy, to water the plants",
  "twice a week in summer, and to tell the landlord about any leak",
  "within two days of finding it.",
  "FINISH-MARKER",
].join(" ");

test("a long text answer wraps inside its box and is kept whole", async () => {
  const items = await extractTextItems(await renderOneTextField(LONG_ANSWER));
  const fieldLeft = NARROW_FIELD.x * 612;
  const fieldRight = (NARROW_FIELD.x + NARROW_FIELD.width) * 612;
  const fieldTop = 792 - NARROW_FIELD.y * 792;
  const fieldBottom = fieldTop - NARROW_FIELD.height * 792;
  const joined = items
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ");

  assert.ok(joined.includes("BEGIN"));
  assert.ok(joined.includes("FINISH-MARKER"));
  assert.ok(new Set(items.map((item) => Math.round(item.y))).size > 1);

  for (const item of items) {
    assert.ok(item.left >= fieldLeft, `${item.text} starts left of its box`);
    assert.ok(item.right <= fieldRight + 0.5, `${item.text} runs past its box`);
    assert.ok(item.y >= fieldBottom && item.y <= fieldTop);
  }
});

test("a short text answer is still drawn on one line", async () => {
  const items = await extractTextItems(await renderOneTextField("Approved"));

  assert.deepEqual(
    items.map((item) => item.text),
    ["Approved"],
  );
});

const ISSUE_90_ANSWER = `BEGIN ${"W".repeat(240)} FINISH-MARKER`;

test("an answer already accepted that is too long is drawn whole, not cut off", async () => {
  const items = await extractTextItems(
    await renderOneTextField(ISSUE_90_ANSWER),
  );
  const joined = items.map((item) => item.text).join("");

  assert.ok(joined.includes("FINISH-MARKER"));
  assert.equal(joined.replace(/[^W]/g, "").length, 240);

  for (const item of items) {
    assert.ok(item.right <= 612, `${item.text} runs off the page`);
  }
});

test("signing is told when an answer cannot fit its box at a readable size", async () => {
  const field = { ...NARROW_FIELD };

  assert.equal(
    await findTypedValueTooLongForField(
      [{ field, value: LONG_ANSWER }],
      [LETTER_PAGE],
    ),
    null,
  );

  const tooLong = await findTypedValueTooLongForField(
    [
      { field, value: "Approved" },
      { field, value: ISSUE_90_ANSWER },
    ],
    [LETTER_PAGE],
  );

  assert.ok(tooLong);
  assert.equal(tooLong.page, 1);
  assert.ok(tooLong.maxCharacters > 0);
  assert.ok(tooLong.maxCharacters < ISSUE_90_ANSWER.length);

  // The length it names does fit.
  assert.equal(
    await findTypedValueTooLongForField(
      [
        {
          field,
          value: Array.from(ISSUE_90_ANSWER)
            .slice(0, tooLong.maxCharacters)
            .join(""),
        },
      ],
      [LETTER_PAGE],
    ),
    null,
  );
});

test("a box shorter than two readable lines takes only one", async () => {
  // 3.6 pt high: one line at the readable size, as before, but no second.
  const field = { ...NARROW_FIELD, height: 0.0045 };

  assert.equal(
    await findTypedValueTooLongForField(
      [{ field, value: "Approved" }],
      [LETTER_PAGE],
    ),
    null,
  );
  assert.ok(
    await findTypedValueTooLongForField(
      [{ field, value: LONG_ANSWER }],
      [LETTER_PAGE],
    ),
  );
});

test("spaces inside an answer are kept as they were typed", async () => {
  const faces = await embedTextFaces(await PDFDocument.create(), [
    "AB  12 and more words",
  ]);

  // pdf.js merges runs of spaces when it extracts text, so the lines are
  // checked as they are laid out.
  assert.deepEqual(wrapFieldText(faces.regular, 10, 500, "AB  12"), ["AB  12"]);
  assert.deepEqual(
    wrapFieldText(faces.regular, 10, 60, "AB  12 and more words"),
    ["AB  12 and", "more words"],
  );
});

test("a captured email is not described as accepted by a mail provider (issue #106)", async () => {
  const fixture = await makeFixture();
  const emailSent = (id: string, messageId: string): AuditEventRecord => ({
    actorType: "system",
    createdAt: 1_799_999_000,
    envelopeId: fixture.envelope.id,
    event: "email_sent",
    id,
    metadata: {
      messageId,
      recipient: "lukasz@example.com",
      signerId: "signer-1",
      template: "signing_invitation",
    },
  });
  const auditEvents = [
    emailSent("event-captured", "capture-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"),
    emailSent("event-provider", "4ef9a417-02e9-4d39-ad75-9611e0fcc33c"),
  ];
  const text = (
    await extractText(
      await renderEnvelopeCertificatePdf(
        {
          auditEvents,
          envelope: fixture.envelope,
          redactForRecipients: false,
          signers: fixture.signers,
        },
        { seal: saveUnsealed },
      ),
    )
  ).replace(/\s+/g, " ");

  assert.ok(
    text.includes(
      "captured locally as capture-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed, not sent",
    ),
    text,
  );
  assert.ok(
    !text.includes(
      "accepted by the mail provider as capture-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
    ),
    text,
  );
  assert.ok(
    text.includes(
      "accepted by the mail provider as 4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
    ),
    text,
  );
});

test("the new wording leaves the audit fingerprint of a captured email unchanged (issue #106)", () => {
  // Certificates sealed before the fix printed this fingerprint for the same
  // row, so they still match the stored audit trail.
  assert.equal(
    computeAuditFingerprint([
      {
        actorType: "system",
        createdAt: 1_799_999_000,
        envelopeId: "env",
        event: "email_sent",
        id: "event-captured",
        metadata: {
          messageId: "capture-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
          recipient: "lukasz@example.com",
          signerId: "signer-1",
          template: "signing_invitation",
        },
      },
    ]),
    "876cbd8661559c69681db5458f3baf2f8e1c8ccc4c43c9352691608e68b61c32",
  );
});
