import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import fontkit from "@pdf-lib/fontkit";
import type { Color, PDFDocument, PDFFont, PDFPage } from "pdf-lib";

// Fonts for the text SignuDoc draws into finished PDFs: field values on the
// signed document, and every line of the audit certificate.
//
// The standard PDF fonts can only draw Windows-1252, and pdf-lib throws on
// anything else, so a name such as "Łukasz" or "山田" used to fail the whole
// signing. Text is now drawn with Noto Sans (Latin, Greek, Cyrillic) and
// falls back to Noto Sans CJK for Chinese, Japanese and Korean. A character
// neither font has is drawn as "\uFFFD". Drawing never throws.
//
// Each PDF embeds only the glyphs it uses. pdf-lib's own subsetting writes
// fonts that some readers cannot open, so the subset is cut with HarfBuzz
// and embedded whole.
//
// Not handled: right-to-left scripts (Arabic, Hebrew) and scripts that need
// glyph shaping (Thai, the Indic scripts). Those draw as "\uFFFD".

// Hotsauce: fonts ship in packages/sign/fonts, found from this file's own
// place (three levels up from src/vendor/services or dist/vendor/services).
// The 14 MB CJK font is left out for now (docs/PLAN-sign.md R6), so Chinese,
// Japanese and Korean text draws as "\uFFFD".
const fontPath = (file: string) =>
  fileURLToPath(new URL(`../../../fonts/${file}`, import.meta.url));

const FONT_PATHS = {
  bold: fontPath("NotoSans-Bold.ttf"),
  regular: fontPath("NotoSans-Regular.ttf"),
  signature: fontPath("GreatVibes-Regular.ttf"),
} as const;

const SUBSETTER_PATH = createRequire(import.meta.url).resolve(
  "harfbuzzjs/dist/harfbuzz-subset.wasm",
);

type FontName = keyof typeof FONT_PATHS;

type LoadedFont = {
  bytes: Uint8Array;
  characters: ReadonlySet<number>;
};

const loadedFonts = new Map<FontName, Promise<LoadedFont>>();

function loadFont(name: FontName): Promise<LoadedFont> {
  let loaded = loadedFonts.get(name);

  if (!loaded) {
    loaded = fs.readFile(FONT_PATHS[name]).then((buffer) => {
      const bytes = new Uint8Array(buffer);

      return {
        bytes,
        characters: new Set(fontkit.create(bytes).characterSet),
      };
    });
    // A failed read is not remembered, so the next PDF tries again.
    loaded.catch(() => loadedFonts.delete(name));
    loadedFonts.set(name, loaded);
  }

  return loaded;
}

type SubsetterExports = {
  free: (pointer: number) => void;
  hb_blob_create: (
    data: number,
    length: number,
    mode: number,
    userData: number,
    destroy: number,
  ) => number;
  hb_blob_destroy: (blob: number) => void;
  hb_blob_get_data: (blob: number, length: number) => number;
  hb_blob_get_length: (blob: number) => number;
  hb_face_create: (blob: number, index: number) => number;
  hb_face_destroy: (face: number) => void;
  hb_face_reference_blob: (face: number) => number;
  hb_set_add: (set: number, value: number) => void;
  hb_set_clear: (set: number) => void;
  hb_subset_input_create_or_fail: () => number;
  hb_subset_input_destroy: (input: number) => void;
  hb_subset_input_set: (input: number, setType: number) => number;
  hb_subset_input_unicode_set: (input: number) => number;
  hb_subset_or_fail: (face: number, input: number) => number;
  malloc: (size: number) => number;
  memory: WebAssembly.Memory;
};

const HB_MEMORY_MODE_WRITABLE = 2;
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6;

let subsetterPromise: Promise<SubsetterExports> | null = null;

function loadSubsetter(): Promise<SubsetterExports> {
  if (!subsetterPromise) {
    subsetterPromise = fs
      .readFile(SUBSETTER_PATH)
      .then((wasm) => WebAssembly.instantiate(wasm))
      .then((result) => result.instance.exports as unknown as SubsetterExports);
    subsetterPromise.catch(() => {
      subsetterPromise = null;
    });
  }

  return subsetterPromise;
}

/**
 * Cuts a TrueType font down to the given characters. Layout features are
 * dropped, so the result maps each character to one glyph and nothing more.
 */
function subsetFont(
  subsetter: SubsetterExports,
  fontBytes: Uint8Array,
  codePoints: Iterable<number>,
): Uint8Array {
  const fontPointer = subsetter.malloc(fontBytes.byteLength);

  if (!fontPointer) {
    throw new Error("The font subsetter is out of memory.");
  }

  let face = 0;
  let input = 0;
  let subsetFace = 0;
  let result = 0;

  try {
    // The buffer is looked up after malloc: growing the memory replaces it.
    new Uint8Array(subsetter.memory.buffer).set(fontBytes, fontPointer);

    const blob = subsetter.hb_blob_create(
      fontPointer,
      fontBytes.byteLength,
      HB_MEMORY_MODE_WRITABLE,
      0,
      0,
    );

    face = subsetter.hb_face_create(blob, 0);
    subsetter.hb_blob_destroy(blob);
    input = subsetter.hb_subset_input_create_or_fail();

    if (!input) {
      throw new Error("The font subsetter could not start.");
    }

    const unicodes = subsetter.hb_subset_input_unicode_set(input);

    for (const codePoint of codePoints) {
      subsetter.hb_set_add(unicodes, codePoint);
    }

    subsetter.hb_set_clear(
      subsetter.hb_subset_input_set(input, HB_SUBSET_SETS_LAYOUT_FEATURE_TAG),
    );
    subsetFace = subsetter.hb_subset_or_fail(face, input);

    if (!subsetFace) {
      throw new Error("The font could not be subset.");
    }

    result = subsetter.hb_face_reference_blob(subsetFace);

    const offset = subsetter.hb_blob_get_data(result, 0);
    const length = subsetter.hb_blob_get_length(result);

    if (!offset || length === 0) {
      throw new Error("The font subset came back empty.");
    }

    return new Uint8Array(subsetter.memory.buffer).slice(
      offset,
      offset + length,
    );
  } finally {
    if (result) subsetter.hb_blob_destroy(result);
    if (subsetFace) subsetter.hb_face_destroy(subsetFace);
    if (input) subsetter.hb_subset_input_destroy(input);
    if (face) subsetter.hb_face_destroy(face);
    subsetter.free(fontPointer);
  }
}

function isSpaceSeparator(codePoint: number): boolean {
  return (
    codePoint === 0x20 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

function isInvisible(codePoint: number): boolean {
  return (
    // C0 and C1 controls.
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    // Soft hyphen, zero-width characters, direction marks and embeddings,
    // word joiner, byte-order mark, variation selectors.
    codePoint === 0xad ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2064) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
    // Unpaired surrogates.
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  );
}

/**
 * What is actually drawn for a piece of text: composed characters, one line,
 * ordinary spaces, and nothing invisible.
 */
export function toDrawableText(value: string): string {
  let drawable = "";

  for (const character of value.normalize("NFC")) {
    const codePoint = character.codePointAt(0)!;

    if (
      isSpaceSeparator(codePoint) ||
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      codePoint === 0x0d ||
      codePoint === 0x85
    ) {
      drawable += " ";
    } else if (!isInvisible(codePoint)) {
      drawable += character;
    }
  }

  return drawable;
}

/** Drawn in place of a character that none of the fonts has. */
const REPLACEMENT_CHARACTER = 0xfffd;

type FaceFont = {
  characters: ReadonlySet<number>;
  font: PDFFont;
};

export type TextRun = {
  font: PDFFont;
  text: string;
};

/** A font with fallbacks: each character is drawn by the first font that has it. */
export class TextFace {
  private readonly fonts: readonly FaceFont[];

  constructor(fonts: readonly FaceFont[]) {
    if (fonts.length === 0) {
      throw new Error("A text face needs at least one font.");
    }

    this.fonts = fonts;
  }

  runs(value: string): TextRun[] {
    const runs: TextRun[] = [];
    let current: FaceFont | null = null;
    let buffer = "";

    for (const character of toDrawableText(value)) {
      const codePoint = character.codePointAt(0)!;
      let drawn = character;
      let next: FaceFont | undefined =
        // A space stays with the text before it.
        codePoint === 0x20 && current
          ? current
          : this.fonts.find((entry) => entry.characters.has(codePoint));

      if (!next) {
        const replacement = this.fonts.find((entry) =>
          entry.characters.has(REPLACEMENT_CHARACTER),
        );

        next = replacement ?? this.fonts[0]!;
        drawn = replacement ? String.fromCodePoint(REPLACEMENT_CHARACTER) : "?";
      }

      if (current && next !== current && buffer) {
        runs.push({ font: current.font, text: buffer });
        buffer = "";
      }

      current = next;
      buffer += drawn;
    }

    if (current && buffer) {
      runs.push({ font: current.font, text: buffer });
    }

    return runs;
  }

  widthOfTextAtSize(value: string, size: number): number {
    return this.runs(value).reduce(
      (width, run) => width + run.font.widthOfTextAtSize(run.text, size),
      0,
    );
  }

  drawText(
    page: PDFPage,
    value: string,
    options: { color?: Color; size: number; x: number; y: number },
  ): void {
    let x = options.x;

    for (const run of this.runs(value)) {
      page.drawText(run.text, {
        color: options.color,
        font: run.font,
        size: options.size,
        x,
        y: options.y,
      });
      x += run.font.widthOfTextAtSize(run.text, options.size);
    }
  }
}

export type PdfTextFaces = {
  bold: TextFace;
  regular: TextFace;
  /** Typed signatures: a script font, falling back to the regular face. */
  signature: TextFace;
};

/** Every code point in every string of a value, however deeply nested. */
export function collectCodePoints(
  value: unknown,
  into: Set<number> = new Set(),
): Set<number> {
  if (typeof value === "string") {
    for (const character of toDrawableText(value)) {
      into.add(character.codePointAt(0)!);
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      collectCodePoints(entry, into);
    }
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      collectCodePoints(entry, into);
    }
  }

  return into;
}

/** Printable ASCII and Latin-1, plus the punctuation the certificate uses. */
function certificateBaseline(): number[] {
  const codePoints: number[] = [];

  for (let codePoint = 0x20; codePoint <= 0x7e; codePoint += 1) {
    codePoints.push(codePoint);
  }

  for (let codePoint = 0xa1; codePoint <= 0xff; codePoint += 1) {
    codePoints.push(codePoint);
  }

  // En dash, em dash, curly quotes, bullet, ellipsis.
  codePoints.push(0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d);
  codePoints.push(0x2022, 0x2026);

  return codePoints;
}

type EmbedTextFacesOptions = {
  /** Embed the bold face. The signed document itself never uses it. */
  bold?: boolean;
  /** Add the characters the certificate's own wording needs. */
  certificate?: boolean;
  /** Embed the script font for typed signatures. */
  signature?: boolean;
  /** For tests: replaces the HarfBuzz subsetter. */
  subset?: (fontBytes: Uint8Array, codePoints: Iterable<number>) => Uint8Array;
};

/**
 * Embeds the fonts a PDF needs to draw `text` (any nested value; every string
 * in it is counted) and returns the faces to draw with.
 */
export async function embedTextFaces(
  pdfDocument: PDFDocument,
  text: unknown,
  options: EmbedTextFacesOptions = {},
): Promise<PdfTextFaces> {
  const codePoints = collectCodePoints(text);

  if (options.certificate) {
    for (const codePoint of certificateBaseline()) {
      codePoints.add(codePoint);
    }
  }

  // Always there: the space, and what stands in for a character no font has.
  codePoints.add(0x20);
  codePoints.add(0x3f);
  codePoints.add(REPLACEMENT_CHARACTER);
  pdfDocument.registerFontkit(fontkit);

  const [regular, bold, signature] = await Promise.all([
    loadFont("regular"),
    options.bold ? loadFont("bold") : null,
    options.signature ? loadFont("signature") : null,
  ]);
  let subset = options.subset ?? null;

  if (!subset) {
    try {
      const subsetter = await loadSubsetter();

      subset = (fontBytes, wanted) => subsetFont(subsetter, fontBytes, wanted);
    } catch (error) {
      console.error(
        "The font subsetter could not be loaded. PDFs will embed whole fonts and leave out the CJK fallback:",
        error,
      );
    }
  }

  const embed = async (
    loaded: LoadedFont,
    { whole = false }: { whole?: boolean } = {},
  ): Promise<FaceFont | null> => {
    const wanted = [...codePoints].filter((codePoint) =>
      loaded.characters.has(codePoint),
    );

    if (whole || !subset) {
      return {
        characters: loaded.characters,
        font: await pdfDocument.embedFont(loaded.bytes),
      };
    }

    try {
      return {
        characters: new Set(wanted),
        font: await pdfDocument.embedFont(subset(loaded.bytes, wanted)),
      };
    } catch (error) {
      console.error("A font could not be subset for a PDF:", error);

      return null;
    }
  };

  // Without a subsetter the Latin fonts are small enough to embed whole. The
  // CJK font is not: at 14 MB it would dwarf the document.
  const regularFont =
    (await embed(regular)) ?? (await embed(regular, { whole: true }))!;
  const boldFont = bold
    ? ((await embed(bold)) ?? (await embed(bold, { whole: true }))!)
    : regularFont;
  const fallbacks: FaceFont[] = [];
  // The script font is embedded whole, as it always was: a typed signature
  // should look the same in every document.
  const signatureFont = signature
    ? await embed(signature, { whole: true })
    : null;

  return {
    bold: new TextFace([boldFont, regularFont, ...fallbacks]),
    regular: new TextFace([regularFont, ...fallbacks]),
    signature: new TextFace([
      ...(signatureFont ? [signatureFont] : []),
      regularFont,
      ...fallbacks,
    ]),
  };
}
