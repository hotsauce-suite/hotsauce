// A small DER reader and writer, for the parts of certificates, timestamp
// tokens, OCSP answers and revocation lists that sealing needs to look at.
//
// It works on byte offsets into the original buffer, so a certificate or a
// token can be passed on byte for byte, which keeps its signature intact.
// Only definite lengths and single-byte tags are read, which is all DER
// (and every structure handled here) uses.

export const TAG = {
  bitString: 0x03,
  boolean: 0x01,
  enumerated: 0x0a,
  generalizedTime: 0x18,
  integer: 0x02,
  null: 0x05,
  octetString: 0x04,
  oid: 0x06,
  sequence: 0x30,
  set: 0x31,
  utcTime: 0x17,
} as const;

/** The identifier byte of a context-specific tag, [n]. */
export function contextTag(number: number, constructed = true): number {
  return 0x80 | (constructed ? 0x20 : 0) | number;
}

export type Tlv = {
  /** Where the content starts. */
  contentStart: number;
  /** One past the last byte of the whole element. */
  end: number;
  /** Where the element, its tag byte, starts. */
  start: number;
  /** The identifier byte: class, constructed bit and tag number. */
  tag: number;
};

export class DerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerError";
  }
}

export function readTlv(
  bytes: Uint8Array,
  offset = 0,
  limit = bytes.length,
): Tlv {
  if (offset + 2 > limit) {
    throw new DerError("The data ends inside an element.");
  }

  const tag = bytes[offset]!;

  if ((tag & 0x1f) === 0x1f) {
    throw new DerError("Multi-byte tags are not supported.");
  }

  const first = bytes[offset + 1]!;
  let length: number;
  let headerLength: number;

  if (first < 0x80) {
    length = first;
    headerLength = 2;
  } else {
    const count = first & 0x7f;

    if (count === 0 || count > 4) {
      throw new DerError("Indefinite or oversized lengths are not supported.");
    }

    if (offset + 2 + count > limit) {
      throw new DerError("The data ends inside a length.");
    }

    length = 0;

    for (let index = 0; index < count; index += 1) {
      length = length * 256 + bytes[offset + 2 + index]!;
    }

    headerLength = 2 + count;
  }

  const contentStart = offset + headerLength;
  const end = contentStart + length;

  if (end > limit) {
    throw new DerError("An element is longer than the data holding it.");
  }

  return { contentStart, end, start: offset, tag };
}

/** The elements directly inside a constructed element. */
export function children(bytes: Uint8Array, parent: Tlv): Tlv[] {
  const items: Tlv[] = [];
  let offset = parent.contentStart;

  while (offset < parent.end) {
    const item = readTlv(bytes, offset, parent.end);

    items.push(item);
    offset = item.end;
  }

  return items;
}

/** The whole element, tag and length included. */
export function elementBytes(bytes: Uint8Array, tlv: Tlv): Buffer {
  return Buffer.from(bytes.subarray(tlv.start, tlv.end));
}

export function contentBytes(bytes: Uint8Array, tlv: Tlv): Buffer {
  return Buffer.from(bytes.subarray(tlv.contentStart, tlv.end));
}

export function expectTag(
  tlv: Tlv | undefined,
  tag: number,
  what: string,
): Tlv {
  if (!tlv || tlv.tag !== tag) {
    throw new DerError(`Expected ${what}.`);
  }

  return tlv;
}

export function decodeOid(content: Uint8Array): string {
  const parts: number[] = [];
  let value = 0;

  for (const byte of content) {
    value = value * 128 + (byte & 0x7f);

    if ((byte & 0x80) === 0) {
      if (parts.length === 0) {
        const first = value < 80 ? Math.floor(value / 40) : 2;

        parts.push(first, value - first * 40);
      } else {
        parts.push(value);
      }

      value = 0;
    }
  }

  return parts.join(".");
}

export function readOid(bytes: Uint8Array, tlv: Tlv): string {
  return decodeOid(contentBytes(bytes, expectTag(tlv, TAG.oid, "an OID")));
}

/** A UTCTime or GeneralizedTime, as a date. */
export function readTime(bytes: Uint8Array, tlv: Tlv): Date {
  const text = contentBytes(bytes, tlv).toString("latin1");
  const match =
    tlv.tag === TAG.utcTime
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(text)
      : tlv.tag === TAG.generalizedTime
        ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/.exec(text)
        : null;

  if (!match) {
    throw new DerError("Expected a time.");
  }

  let year = Number(match[1]);

  if (tlv.tag === TAG.utcTime) {
    year += year < 50 ? 2000 : 1900;
  }

  return new Date(
    Date.UTC(
      year,
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] ?? "0"),
    ),
  );
}

// --- Writing -------------------------------------------------------------

function encodeLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }

  const bytes: number[] = [];
  let rest = length;

  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }

  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function encode(tag: number, ...content: Uint8Array[]): Buffer {
  const body = Buffer.concat(content);

  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

export function encodeOid(value: string): Buffer {
  const parts = value.split(".").map(Number);
  const numbers = [parts[0]! * 40 + parts[1]!, ...parts.slice(2)];
  const bytes: number[] = [];

  for (const number of numbers) {
    const chunk: number[] = [number & 0x7f];
    let rest = Math.floor(number / 128);

    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }

    bytes.push(...chunk);
  }

  return encode(TAG.oid, Buffer.from(bytes));
}

/** An INTEGER from unsigned big-endian bytes. */
export function encodeUnsignedInteger(value: Uint8Array): Buffer {
  let start = 0;

  while (start < value.length - 1 && value[start] === 0) {
    start += 1;
  }

  const trimmed = Buffer.from(value.subarray(start));

  return encode(
    TAG.integer,
    trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed,
  );
}

export function encodeSmallInteger(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;

  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);

  if (bytes[0]! & 0x80) {
    bytes.unshift(0);
  }

  return encode(TAG.integer, Buffer.from(bytes));
}

export const der = {
  null: () => Buffer.from([TAG.null, 0]),
  octets: (value: Uint8Array) => encode(TAG.octetString, value),
  oid: encodeOid,
  sequence: (...items: Uint8Array[]) => encode(TAG.sequence, ...items),
  set: (...items: Uint8Array[]) => encode(TAG.set, ...items),
};

/** An AlgorithmIdentifier with NULL parameters, as hash algorithms use. */
export function algorithm(oid: string): Buffer {
  return der.sequence(der.oid(oid), der.null());
}
