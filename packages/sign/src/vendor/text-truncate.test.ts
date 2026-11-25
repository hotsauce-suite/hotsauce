// Copied from SignuDoc (MIT, Copyright (c) 2026 Nyllon Software); see ./LICENSE-SignuDoc.
import assert from "node:assert/strict";
import { test } from "vitest";

import { truncateToWholeCharacters } from "./text-truncate.ts";

test("short text is returned as it is", () => {
  assert.equal(truncateToWholeCharacters("Acme 😀", 80), "Acme 😀");
});

test("a cut inside an emoji drops the whole emoji", () => {
  assert.equal(
    truncateToWholeCharacters(`${"a".repeat(63)}😀`, 64),
    "a".repeat(63),
  );
});

test("a joined emoji is kept or dropped in one piece", () => {
  const family = "👨‍👩‍👧";

  assert.equal(truncateToWholeCharacters(`ab${family}`, 5), "ab");
  assert.equal(truncateToWholeCharacters(`ab${family}c`, 10), `ab${family}`);
});

test("a lone surrogate already in the text becomes U+FFFD", () => {
  assert.equal(truncateToWholeCharacters("a\ud83db", 80), "a�b");
});
