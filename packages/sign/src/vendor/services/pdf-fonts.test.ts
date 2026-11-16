// Copied from SignuDoc (MIT, Copyright (c) 2026 Nyllon Software); see ../LICENSE-SignuDoc.
import assert from "node:assert/strict";
import { test } from "vitest";

import { PDFDocument } from "pdf-lib";

import {
  collectCodePoints,
  embedTextFaces,
  toDrawableText,
} from "./pdf-fonts.ts";

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
        .join(""),
    );
  }

  await document.cleanup();

  return parts.join("\n");
}

test("toDrawableText keeps one line of visible characters", () => {
  assert.equal(toDrawableText("a\tb\nc\r\nd"), "a b c  d");
  assert.equal(toDrawableText("9:41 AM"), "9:41 AM");
  assert.equal(toDrawableText("zero​width﻿"), "zerowidth");
  // Decomposed "é" is drawn as the single composed character.
  assert.equal(toDrawableText("Café"), "Café");
  assert.equal(toDrawableText("\ud800"), "");
});

test("collectCodePoints walks every string in a value", () => {
  const codePoints = collectCodePoints([
    { name: "Ab", nested: { value: "c" } },
    null,
    7,
    ["山"],
  ]);

  assert.deepEqual(
    [...codePoints].sort((left, right) => left - right),
    [0x41, 0x62, 0x63, 0x5c71],
  );
});

test("text outside Windows-1252 is drawn and can be read back", async () => {
  const lines = [
    "Zażółć gęślą jaźń Łukasz",
    "Привет мир Ελληνικά Việt",
  ];
  const pdfDocument = await PDFDocument.create();
  const faces = await embedTextFaces(pdfDocument, lines, {
    bold: true,
    certificate: true,
    signature: true,
  });
  const page = pdfDocument.addPage([612, 400]);

  lines.forEach((line, index) => {
    faces.regular.drawText(page, line, {
      size: 12,
      x: 40,
      y: 340 - index * 30,
    });
    faces.bold.drawText(page, line, { size: 12, x: 40, y: 240 - index * 30 });
  });
  faces.signature.drawText(page, "Łukasz Ελληνικά", { size: 24, x: 40, y: 100 });

  const pdfBytes = await pdfDocument.save();
  const text = await extractText(pdfBytes);

  for (const line of lines) {
    assert.ok(text.includes(line), `missing: ${line}`);
  }

  assert.ok(text.includes("Łukasz Ελληνικά"));
  // Two subset fonts plus the whole script font.
  assert.ok(
    pdfBytes.byteLength < 700_000,
    `PDF is ${String(pdfBytes.byteLength)} bytes`,
  );
});

// Hotsauce: SignuDoc falls back to Noto Sans CJK here. Hotsauce leaves that
// font out (docs/PLAN-sign.md R6), so CJK text is drawn as U+FFFD, in one run.
test("CJK text is drawn as U+FFFD while the CJK font is left out", async () => {
  const pdfDocument = await PDFDocument.create();
  const faces = await embedTextFaces(pdfDocument, [
    "Signed by 山田 太郎 today",
  ]);
  const runs = faces.regular.runs("Signed by 山田 太郎 today");

  assert.deepEqual(
    runs.map((run) => run.text),
    ["Signed by \uFFFD\uFFFD \uFFFD\uFFFD today"],
  );
});

test("a character no font has becomes U+FFFD instead of failing", async () => {
  const pdfDocument = await PDFDocument.create();
  const faces = await embedTextFaces(pdfDocument, ["مرحبا שלום 😀 ok"]);
  const page = pdfDocument.addPage([400, 100]);

  assert.doesNotThrow(() => {
    faces.regular.drawText(page, "مرحبا שלום 😀 ok", {
      size: 12,
      x: 10,
      y: 50,
    });
    // Text that was never announced to embedTextFaces is replaced too.
    faces.regular.drawText(page, "山", { size: 12, x: 10, y: 20 });
  });

  const text = await extractText(await pdfDocument.save());

  assert.match(text, /�+ �+ � ok/);
});

test("without a subsetter whole Latin fonts are embedded and CJK is left out", async () => {
  const pdfDocument = await PDFDocument.create();
  const faces = await embedTextFaces(pdfDocument, ["Łukasz 山田"], {
    subset: () => {
      throw new Error("no subsetter");
    },
  });
  const page = pdfDocument.addPage([400, 100]);

  faces.regular.drawText(page, "Łukasz 山田", { size: 12, x: 10, y: 50 });

  const text = await extractText(await pdfDocument.save());

  assert.ok(text.includes("Łukasz"));
  assert.ok(!text.includes("山田"));
});
