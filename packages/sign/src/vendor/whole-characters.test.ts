// Copied from SignuDoc (MIT, Copyright (c) 2026 Nyllon Software); see ./LICENSE-SignuDoc.
import assert from "node:assert/strict";
import { test } from "vitest";

import {
  splitIntoWholeCharacters,
  splitWithoutSegmenter,
  toWellFormedWithoutBuiltIn,
} from "./whole-characters.ts";

const samples = [
  "Robin Casey 😀",
  "e\u{301}lodie",
  "👍🏽 ok",
  "👩🏽‍💻 dev",
  "👨‍👩‍👧‍👦 family",
  "❤️ love",
  "1️⃣ keycap",
  "🏴󠁧󠁢󠁳󠁣󠁴󠁿 flag",
  "🇺🇸",
  "🇺🇸🇫🇷🇩",
  "Kim 김민준",
  "\u{1100}\u{1161}\u{11A8} jamo",
  "\u{AC00}\u{11A8}",
  "क्षमा शर्मा",
  "ক্ষ স্ত",
  "ਸਿੰਘ",
  "สมชาย",
  "a\r\nb",
  "\u{200D}a",
  "😀\u{200D}",
  "\u{1019}\u{102C}",
  "\u{113D1}\u{11392}",
  "\u{D15}\u{D4D}\u{D3E}\u{D15}",
  "\u{915}\u{94D}\u{200C}\u{924}",
  "a\u{200D}😀",
];

// Browsers without Intl.Segmenter (Firefox 115 ESR) take the fallback path.
// The server always has the segmenter, so the two must agree, or an avatar
// rendered on the server won't hydrate.
test("the fallback splits like Intl.Segmenter", () => {
  for (const sample of samples) {
    assert.deepEqual(
      splitWithoutSegmenter(sample),
      splitIntoWholeCharacters(sample),
      JSON.stringify(sample),
    );
  }
});

test("the fallback agrees on every Indic consonant-virama-consonant", () => {
  for (const virama of [0x94d, 0x9cd, 0xacd, 0xb4d, 0xc4d, 0xd4d]) {
    const ka = String.fromCodePoint(virama - 0x4d + 0x15);

    for (let code = virama - 0x4d; code < virama - 0x4d + 0x80; code += 1) {
      const sample = `${ka}${String.fromCodePoint(virama)}${String.fromCodePoint(code)}`;

      assert.deepEqual(
        splitWithoutSegmenter(sample),
        splitIntoWholeCharacters(sample),
        JSON.stringify(sample),
      );
    }
  }
});

test("the fallback agrees on every Hangul jamo pair", () => {
  const jamo = [
    0x1100, 0x115f, 0x1160, 0x11a7, 0x11a8, 0x11ff, 0xa960, 0xd7b0, 0xd7cb,
    0xac00, 0xac01,
  ];

  for (const first of jamo) {
    for (const second of jamo) {
      const sample = String.fromCodePoint(first, second);

      assert.deepEqual(
        splitWithoutSegmenter(sample),
        splitIntoWholeCharacters(sample),
        JSON.stringify(sample),
      );
    }
  }
});

test("the toWellFormed fallback matches the built-in", () => {
  for (const sample of [
    ...samples,
    "\u{FFFD}",
    String.fromCharCode(0xd83d),
    `a${String.fromCharCode(0xd83d)}b`,
    `${String.fromCharCode(0xde00)}x`,
    `x😀${String.fromCharCode(0xd83d)}`,
  ]) {
    assert.equal(toWellFormedWithoutBuiltIn(sample), sample.toWellFormed());
  }
});

// Every code point after each kind of character the fallback tracks. Indic
// conjuncts are checked only within the six scripts the table covers: newer
// ICU versions join more scripts there, and browsers differ on those anyway.
test("the fallback agrees on every code point after each kind of start", () => {
  const ranges: Array<[number, number]> = [
    [0x0, 0xd7ff],
    [0xe000, 0xffff],
    [0x11000, 0x11fff],
    [0x1f000, 0x1faff],
    [0xe0000, 0xe01ef],
  ];
  const starts = [
    "a",
    "\u{1F469}\u{200D}",
    "\u{1F1FA}",
    "\u{1100}",
    "x\u{600}",
    "\r",
  ];
  const mismatches: string[] = [];

  function check(sample: string) {
    const expected = splitIntoWholeCharacters(sample);
    const actual = splitWithoutSegmenter(sample);

    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      mismatches.push(JSON.stringify(sample));
    }
  }

  for (const start of starts) {
    for (const [from, to] of ranges) {
      for (let code = from; code <= to; code += 1) {
        check(`${start}${String.fromCodePoint(code)}b`);
      }
    }
  }

  for (let code = 0x900; code <= 0xd7f; code += 1) {
    check(`\u{915}\u{94D}${String.fromCodePoint(code)}\u{915}`);
    check(`\u{D15}\u{D4D}${String.fromCodePoint(code)}\u{D15}`);
  }

  assert.deepEqual(mismatches.slice(0, 20), []);
});
