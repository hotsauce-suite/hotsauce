// Copied from SignuDoc (MIT, Copyright (c) 2026 Nyllon Software); see ./LICENSE-SignuDoc.
// Helpers for cutting text only between whole characters. They run in the
// browser too, so they don't rely on Intl.Segmenter (Firefox 125+) or
// String.prototype.toWellFormed (Firefox 119+) being present: Firefox 115 ESR
// has neither. The server always has both, so the fallback has to find the
// same character boundaries, or a server-rendered avatar won't hydrate.

const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

const replacementCharacter = String.fromCharCode(0xfffd);

// Swaps each lone surrogate for U+FFFD, like toWellFormed().
export function toWellFormedText(value: string): string {
  if (typeof value.toWellFormed === "function") {
    return value.toWellFormed();
  }

  return toWellFormedWithoutBuiltIn(value);
}

// Exported for tests. Iterating a string by code point yields a lone
// surrogate as a one-unit string, which is how it is found here (no regex
// lookbehind, which Safari before 16.4 can't parse).
export function toWellFormedWithoutBuiltIn(value: string): string {
  let result = "";

  for (const codePoint of value) {
    const unit = codePoint.charCodeAt(0);
    const isLone = codePoint.length === 1 && unit >= 0xd800 && unit <= 0xdfff;

    result += isLone ? replacementCharacter : codePoint;
  }

  return result;
}

// Splits text into whole characters (grapheme clusters).
export function splitIntoWholeCharacters(value: string): string[] {
  const text = toWellFormedText(value);

  if (graphemeSegmenter) {
    return Array.from(
      graphemeSegmenter.segment(text),
      ({ segment }) => segment,
    );
  }

  return splitWithoutSegmenter(text);
}

// Code points that belong to the character before them: combining and
// spacing marks (Thai and Lao AM are letters Unicode treats as marks here),
// the zero-width non-joiner and joiner, halfwidth kana voicing marks,
// variation selectors, emoji skin tones and tag characters.
const extendsCharacter =
  /^[\p{M}\u{0E33}\u{0EB3}\u{200C}\u{200D}\u{FF9E}\u{FF9F}\u{FE00}-\u{FE0F}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u;
// Spacing vowel signs Unicode leaves out of grapheme extension (mostly
// Myanmar), so they start a character of their own.
const markThatStandsAlone =
  /^[\u{102B}\u{102C}\u{1038}\u{1062}-\u{1064}\u{1067}-\u{106D}\u{1083}\u{1087}-\u{108C}\u{108F}\u{109A}-\u{109C}\u{1A61}\u{1A63}\u{1A64}\u{AA7B}\u{AA7D}\u{11720}\u{11721}]$/u;
const zeroWidthNonJoiner = "\u{200C}";
const zeroWidthJoiner = "\u{200D}";

function extendsPrevious(codePoint: string): boolean {
  return (
    extendsCharacter.test(codePoint) && !markThatStandsAlone.test(codePoint)
  );
}
// Spacing marks (\p{Mc}) that Unicode nonetheless counts as plain grapheme
// extension, mostly vowel length marks: these keep an emoji ZWJ sequence or
// an Indic conjunct going, where other spacing marks end it.
const spacingMarkThatExtends =
  /^[\u{9BE}\u{9D7}\u{B3E}\u{B57}\u{BBE}\u{BD7}\u{CC0}\u{CC2}\u{CC7}-\u{CC8}\u{CCA}-\u{CCB}\u{CD5}-\u{CD6}\u{D3E}\u{D57}\u{DCF}\u{DDF}\u{1715}\u{1734}\u{1B35}\u{1B3B}\u{1B3D}\u{1B43}-\u{1B44}\u{1BAA}\u{1BF2}-\u{1BF3}\u{302E}-\u{302F}\u{A953}\u{A9C0}\u{111C0}\u{11235}\u{1133E}\u{1134D}\u{11357}\u{113B8}\u{113C2}\u{113C5}\u{113C7}-\u{113C9}\u{113CF}\u{114B0}\u{114BD}\u{115AF}\u{116B6}\u{11930}\u{1193D}\u{11F41}\u{16FF0}-\u{16FF1}\u{1D165}-\u{1D166}\u{1D16D}-\u{1D172}]$/u;

function isSpacingMark(codePoint: string): boolean {
  return (
    /^[\p{Mc}\u{0E33}\u{0EB3}]$/u.test(codePoint) &&
    !spacingMarkThatExtends.test(codePoint)
  );
}
const extendedPictographic = /^\p{Extended_Pictographic}$/u;

type HangulPart = "L" | "V" | "T" | "LV" | "LVT";

function hangulPart(code: number): HangulPart | null {
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0xa960 && code <= 0xa97c)
  ) {
    return "L";
  }

  if (
    (code >= 0x1160 && code <= 0x11a7) ||
    (code >= 0xd7b0 && code <= 0xd7c6)
  ) {
    return "V";
  }

  if (
    (code >= 0x11a8 && code <= 0x11ff) ||
    (code >= 0xd7cb && code <= 0xd7fb)
  ) {
    return "T";
  }

  if (code >= 0xac00 && code <= 0xd7a3) {
    return (code - 0xac00) % 28 === 0 ? "LV" : "LVT";
  }

  return null;
}

// Unicode's rules for which Hangul jamo join into one syllable.
function hangulJoins(previous: HangulPart, next: HangulPart): boolean {
  if (previous === "L") {
    return next !== "T";
  }

  if (previous === "V" || previous === "LV") {
    return next === "V" || next === "T";
  }

  return next === "T";
}

// Characters that join the character after them (Arabic number signs and
// a few others Unicode calls Prepend).
const prepend =
  /^[\u{0600}-\u{0605}\u{06DD}\u{070F}\u{0890}\u{0891}\u{08E2}\u{0D4E}\u{110BD}\u{110CD}\u{111C2}\u{111C3}\u{113D1}\u{1193F}\u{11941}\u{11A84}-\u{11A89}\u{11D46}\u{11F02}]$/u;
const formatCharacter = /^\p{Cf}$/u;
const controlCharacter = /^[\p{Cc}\p{Zl}\p{Zp}]$/u;
const unassigned = /^\p{Cn}$/u;
const defaultIgnorable = /^\p{Default_Ignorable_Code_Point}$/u;

// Unicode's Control class: nothing joins onto or after these, apart from CR LF.
function isControl(codePoint: string): boolean {
  if (controlCharacter.test(codePoint)) {
    return true;
  }

  // Unassigned code points reserved as invisible also count as Control.
  if (unassigned.test(codePoint) && defaultIgnorable.test(codePoint)) {
    return true;
  }

  return (
    formatCharacter.test(codePoint) &&
    !extendsPrevious(codePoint) &&
    !prepend.test(codePoint)
  );
}

function isRegionalIndicator(code: number): boolean {
  return code >= 0x1f1e6 && code <= 0x1f1ff;
}

// Indic conjuncts (consonant, virama, consonant) are one character. These
// are Unicode's InCB=Linker viramas and InCB=Consonant letters, for
// Devanagari, Bengali, Gujarati, Oriya, Telugu and Malayalam.
const indicLinkers = new Set([0x94d, 0x9cd, 0xacd, 0xb4d, 0xc4d, 0xd4d]);
const indicConsonantRanges: ReadonlyArray<readonly [number, number]> = [
  [0x915, 0x939],
  [0x958, 0x95f],
  [0x978, 0x97f],
  [0x995, 0x9a8],
  [0x9aa, 0x9b0],
  [0x9b2, 0x9b2],
  [0x9b6, 0x9b9],
  [0x9dc, 0x9dd],
  [0x9df, 0x9df],
  [0x9f0, 0x9f1],
  [0xa95, 0xaa8],
  [0xaaa, 0xab0],
  [0xab2, 0xab3],
  [0xab5, 0xab9],
  [0xaf9, 0xaf9],
  [0xb15, 0xb28],
  [0xb2a, 0xb30],
  [0xb32, 0xb33],
  [0xb35, 0xb39],
  [0xb5c, 0xb5d],
  [0xb5f, 0xb5f],
  [0xb71, 0xb71],
  [0xc15, 0xc28],
  [0xc2a, 0xc39],
  [0xc58, 0xc5a],
  [0xd15, 0xd3a],
];

function isIndicConsonant(code: number): boolean {
  return indicConsonantRanges.some(([from, to]) => code >= from && code <= to);
}

// Exported for tests: the path browsers without Intl.Segmenter take. It
// follows the parts of the Unicode grapheme rules a name can plausibly hit:
// CR LF, marks and modifiers, emoji joined by ZWJ, flag pairs, Hangul jamo
// and Indic conjuncts.
export function splitWithoutSegmenter(text: string): string[] {
  const characters: string[] = [];
  let previous = "";
  let previousControl = false;
  let previousPrepend = false;
  let previousHangul: HangulPart | null = null;
  let regionalIndicatorRun = 0;
  let inPictographicSequence = false;
  let pictographicBeforeJoiner = false;
  // "consonant" after an Indic consonant, "linked" once a virama follows it.
  let conjunct: "consonant" | "linked" | null = null;

  for (const codePoint of text) {
    const code = codePoint.codePointAt(0)!;
    const hangul = hangulPart(code);
    const regional = isRegionalIndicator(code);
    const pictographic = extendedPictographic.test(codePoint);
    const indicConsonant = isIndicConsonant(code);
    const control = isControl(codePoint);

    const joins =
      characters.length > 0 &&
      ((previous === "\r" && codePoint === "\n") ||
        (!previousControl &&
          !control &&
          (previousPrepend ||
            extendsPrevious(codePoint) ||
            (pictographic && pictographicBeforeJoiner) ||
            (regional && regionalIndicatorRun % 2 === 1) ||
            (indicConsonant && conjunct === "linked") ||
            (hangul !== null &&
              previousHangul !== null &&
              hangulJoins(previousHangul, hangul)))));

    if (joins) {
      characters[characters.length - 1] += codePoint;
    } else {
      characters.push(codePoint);
    }

    // Spacing marks join the character but, unlike other marks, end an
    // emoji ZWJ sequence or an Indic conjunct.
    const nonSpacingExtend =
      extendsPrevious(codePoint) && !isSpacingMark(codePoint);

    pictographicBeforeJoiner =
      codePoint === zeroWidthJoiner && inPictographicSequence;
    inPictographicSequence =
      pictographic ||
      (inPictographicSequence &&
        nonSpacingExtend &&
        codePoint !== zeroWidthJoiner);

    if (indicConsonant) {
      conjunct = "consonant";
    } else if (conjunct !== null && indicLinkers.has(code)) {
      conjunct = "linked";
    } else if (
      conjunct !== null &&
      (codePoint === zeroWidthNonJoiner || !nonSpacingExtend)
    ) {
      conjunct = null;
    }

    regionalIndicatorRun = regional ? regionalIndicatorRun + 1 : 0;
    previousHangul = hangul;
    previous = codePoint;
    previousControl = control;
    previousPrepend = prepend.test(codePoint);
  }

  return characters;
}
