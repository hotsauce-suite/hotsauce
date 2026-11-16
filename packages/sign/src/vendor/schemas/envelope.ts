import { z } from "zod";

import {
  auditActorTypes,
  auditEventTypes,
  downloadFileTypes,
  envelopeStatuses,
  MAX_ENVELOPE_DEADLINE_DAYS,
  MAX_ENVELOPE_REMINDER_DAYS,
} from "../types/domain.ts";
import {
  emailSchema,
  envelopeTitleSchema,
  idSchema,
  optionalTrimmedString,
  unixTimestampSchema,
} from "./common.ts";

const sourcePdfHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const envelopeStatusSchema = z.enum(envelopeStatuses);
export const downloadFileTypeSchema = z.enum(downloadFileTypes);
export const auditEventTypeSchema = z.enum(auditEventTypes);
export const auditActorTypeSchema = z.enum(auditActorTypes);

export const envelopeCreateResponseSchema = z.object({
  envelopeId: idSchema,
  pageCount: z.number().int().positive(),
  redirectPath: z.string().trim().min(1),
  sourcePdfFilename: z.string().trim().min(1).max(255),
  sourcePdfSizeBytes: z.number().int().positive(),
  title: envelopeTitleSchema,
});

export const deadlineDaysSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_ENVELOPE_DEADLINE_DAYS);

/** Days between automatic reminders. Null turns them off. */
export const reminderIntervalDaysSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_ENVELOPE_REMINDER_DAYS)
  .nullable();

/** What the sender chooses on the last step before sending. */
export const sendEnvelopeOptionsSchema = z.object({
  expiresInDays: deadlineDaysSchema.optional(),
  reminderIntervalDays: reminderIntervalDaysSchema.optional(),
  /** Simple unless the install has a signing provider. */
  signatureLevel: z.enum(["simple", "advanced", "qualified"]).optional(),
});

export const changeRemindersSchema = z.object({
  reminderIntervalDays: reminderIntervalDaysSchema,
});

export const changeRemindersResponseSchema = z.object({
  envelopeId: idSchema,
  reminderIntervalDays: reminderIntervalDaysSchema,
});

export const changeDeadlineSchema = z.object({
  expiresInDays: deadlineDaysSchema,
});

export const changeDeadlineResponseSchema = z.object({
  envelopeId: idSchema,
  expiresAt: unixTimestampSchema,
  expiresAtLabel: z.string().trim().min(1),
});

export const sendEnvelopeResponseSchema = z.object({
  envelopeId: idSchema,
  expiresAt: unixTimestampSchema.nullable().optional(),
  notifiedSignerName: z.string().trim().min(1).max(160),
  redirectPath: z.string().trim().min(1),
  sentAt: unixTimestampSchema,
});

export const voidEnvelopeResponseSchema = z.object({
  envelopeId: idSchema,
  redirectPath: z.string().trim().min(1),
  voidedAt: unixTimestampSchema,
});

export const copyEnvelopeResponseSchema = z.object({
  id: idSchema,
});

export const manualNudgeResponseSchema = z.object({
  envelopeId: idSchema,
  nextAvailableAt: unixTimestampSchema,
  nextAvailableAtLabel: z.string().trim().min(1),
  sentAt: unixTimestampSchema,
  signerId: idSchema,
  signerName: z.string().trim().min(1).max(160),
});

export const envelopeListFiltersSchema = z.object({
  status: envelopeStatusSchema.optional(),
  search: optionalTrimmedString(160),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const downloadRequestSchema = z.object({
  type: downloadFileTypeSchema,
});

export const envelopePageSchema = z.object({
  id: idSchema.optional(),
  envelopeId: idSchema.optional(),
  pageNumber: z.number().int().positive(),
  widthPt: z.number().positive(),
  heightPt: z.number().positive(),
});

export const auditEventRecordSchema = z.object({
  id: idSchema,
  envelopeId: idSchema,
  event: auditEventTypeSchema,
  actorType: auditActorTypeSchema,
  actorEmail: emailSchema.nullable().optional(),
  ipAddress: z.string().trim().min(1).nullable().optional(),
  userAgent: z.string().trim().min(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: unixTimestampSchema,
});

/** How the signers sign. See provider-signing.ts. */
export const signatureLevelSchema = z.enum(["simple", "advanced", "qualified"]);

export type EnvelopeSignatureLevel = z.infer<typeof signatureLevelSchema>;

export const envelopeRecordSchema = z.object({
  id: idSchema,
  userId: idSchema,
  title: envelopeTitleSchema,
  status: envelopeStatusSchema,
  sourcePdfKey: z.string().trim().min(1),
  sourcePdfFilename: z.string().trim().min(1).max(255),
  sourcePdfSizeBytes: z.number().int().positive(),
  pageCount: z.number().int().positive(),
  signedPdfKey: z.string().trim().min(1).nullable().optional(),
  evidenceKey: z.string().trim().min(1).nullable().optional(),
  sourcePdfHash: sourcePdfHashSchema,
  signedPdfSha256: sourcePdfHashSchema.nullable().optional(),
  evidenceSha256: sourcePdfHashSchema.nullable().optional(),
  recipientEvidenceSha256: sourcePdfHashSchema.nullable().optional(),
  sentAt: unixTimestampSchema.nullable().optional(),
  completedAt: unixTimestampSchema.nullable().optional(),
  declinedAt: unixTimestampSchema.nullable().optional(),
  voidedAt: unixTimestampSchema.nullable().optional(),
  /** When the request stops being signable. See envelope-deadline.ts. */
  expiresAt: unixTimestampSchema.nullable().optional(),
  /** Days between automatic reminders, or null for none. */
  reminderIntervalDays: reminderIntervalDaysSchema.optional(),
  /** Sent in Part 11 mode. See part11.ts. */
  part11: z.boolean().optional(),
  /**
   * Simple, or signed by each signer with a certificate in their own name
   * through a signing provider. See provider-signing.ts.
   */
  signatureLevel: signatureLevelSchema.optional(),
  signatureProvider: z.string().trim().min(1).nullable().optional(),
  /** The PDF as the last signer signed it, for provider signatures. */
  revisionKey: z.string().trim().min(1).nullable().optional(),
  revisionSha256: sourcePdfHashSchema.nullable().optional(),
  createdAt: unixTimestampSchema,
  updatedAt: unixTimestampSchema,
});

export type CreateEnvelopeResponse = z.infer<
  typeof envelopeCreateResponseSchema
>;
export type SendEnvelopeResponse = z.infer<typeof sendEnvelopeResponseSchema>;
export type SendEnvelopeOptions = z.infer<typeof sendEnvelopeOptionsSchema>;
export type ChangeDeadlineResponse = z.infer<
  typeof changeDeadlineResponseSchema
>;
export type ChangeRemindersResponse = z.infer<
  typeof changeRemindersResponseSchema
>;
export type VoidEnvelopeResponse = z.infer<typeof voidEnvelopeResponseSchema>;
export type CopyEnvelopeResponse = z.infer<typeof copyEnvelopeResponseSchema>;
export type ManualNudgeResponse = z.infer<typeof manualNudgeResponseSchema>;
export type EnvelopeListFilters = z.infer<typeof envelopeListFiltersSchema>;
export type DownloadRequest = z.infer<typeof downloadRequestSchema>;
export type EnvelopePageRecord = z.infer<typeof envelopePageSchema>;
export type AuditEventRecord = z.infer<typeof auditEventRecordSchema>;
export type EnvelopeRecord = z.infer<typeof envelopeRecordSchema>;
