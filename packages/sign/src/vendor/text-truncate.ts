// Copied from SignuDoc (MIT, Copyright (c) 2026 Nyllon Software); see ./LICENSE-SignuDoc.
import {
  splitIntoWholeCharacters,
  toWellFormedText,
} from "./whole-characters.ts";

// Shortens text to at most maxLength UTF-16 code units, cutting only between
// whole characters, so an emoji (or a letter with its accent) is kept or
// dropped in one piece. A plain slice can leave half of a surrogate pair,
// which makes encodeURIComponent and UTF-8 encoders throw.
export function truncateToWholeCharacters(
  value: string,
  maxLength: number,
): string {
  const wellFormed = toWellFormedText(value);

  if (wellFormed.length <= maxLength) {
    return wellFormed;
  }

  let result = "";

  for (const segment of splitIntoWholeCharacters(wellFormed)) {
    if (result.length + segment.length > maxLength) {
      break;
    }

    result += segment;
  }

  return result;
}
