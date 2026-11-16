import { z } from "zod";

export const idSchema = z.string().trim().min(1);
export const nonEmptyStringSchema = z.string().trim().min(1);
export const emailSchema = z.string().trim().email().max(320);
export const nameSchema = nonEmptyStringSchema.max(120);
export const envelopeTitleSchema = nonEmptyStringSchema.max(160);
export const unixTimestampSchema = z.number().int().nonnegative();
export const normalizedCoordinateSchema = z.number().finite().min(0).max(1);
export const normalizedSizeSchema = z.number().finite().gt(0).max(1);

function emptyStringToUndefined(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmedValue = value.trim();

  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

export function optionalTrimmedString(maxLength: number) {
  return z.preprocess(
    emptyStringToUndefined,
    z.string().max(maxLength).optional(),
  );
}
