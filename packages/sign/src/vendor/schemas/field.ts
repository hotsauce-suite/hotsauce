import { z } from "zod";

import {
  MAX_FIELD_OPTION_LENGTH,
  MAX_FIELD_OPTIONS,
  MAX_NUMBER_ENTRY_LENGTH,
  MAX_RADIO_GROUP_BUTTONS,
} from "../field-choices.ts";
import { fieldInputMethods, fieldTypes } from "../types/domain.ts";
import {
  idSchema,
  normalizedCoordinateSchema,
  normalizedSizeSchema,
  optionalTrimmedString,
  unixTimestampSchema,
} from "./common.ts";

export const fieldTypeSchema = z.enum(fieldTypes);
export const fieldInputMethodSchema = z.enum(fieldInputMethods);

export const MAX_DRAWN_SIGNATURE_BYTES = 256 * 1024;
const MAX_DRAWN_SIGNATURE_DATA_URL_LENGTH =
  "data:image/png;base64,".length +
  Math.ceil(MAX_DRAWN_SIGNATURE_BYTES / 3) * 4;

export const fieldPlacementSchema = z
  .object({
    id: idSchema.optional(),
    envelopeId: idSchema.optional(),
    signerId: idSchema,
    type: fieldTypeSchema,
    page: z.number().int().positive(),
    x: normalizedCoordinateSchema,
    y: normalizedCoordinateSchema,
    width: normalizedSizeSchema,
    height: normalizedSizeSchema,
    required: z.boolean().default(true),
    label: optionalTrimmedString(120),
    // The choices of a dropdown. A draft may hold fewer than two while the
    // sender is still typing them; sending checks for that.
    options: z
      .array(z.string().trim().min(1).max(MAX_FIELD_OPTION_LENGTH))
      .max(MAX_FIELD_OPTIONS)
      .optional(),
    // The group a radio button belongs to. The signer picks one per group.
    groupId: z.string().trim().min(1).max(64).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.options !== undefined && field.type !== "dropdown") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only dropdown fields have choices",
        path: ["options"],
      });
    }

    if (
      field.options !== undefined &&
      new Set(field.options).size !== field.options.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each choice in a dropdown must be different",
        path: ["options"],
      });
    }

    if ((field.type === "radio") !== (field.groupId !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          field.type === "radio"
            ? "A radio button must belong to a group"
            : "Only radio buttons belong to a group",
        path: ["groupId"],
      });
    }

    if (field.x + field.width > 1.000001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Field width extends beyond the page bounds",
        path: ["width"],
      });
    }

    if (field.y + field.height > 1.000001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Field height extends beyond the page bounds",
        path: ["height"],
      });
    }

    if (
      (field.type === "signature" ||
        field.type === "initials" ||
        field.type === "date") &&
      !field.required
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field.type} fields are always required`,
        path: ["required"],
      });
    }
  });

// The buttons of one radio group are answered together, so they must agree
// on who answers them and on whether an answer is needed.
export const fieldPlacementListSchema = z
  .array(fieldPlacementSchema)
  .superRefine((fields, ctx) => {
    const groups = new Map<
      string,
      { count: number; required: boolean; signerId: string }
    >();

    fields.forEach((field, index) => {
      if (field.type !== "radio" || field.groupId === undefined) {
        return;
      }

      const group = groups.get(field.groupId);

      if (!group) {
        groups.set(field.groupId, {
          count: 1,
          required: field.required,
          signerId: field.signerId,
        });
        return;
      }

      group.count += 1;

      if (
        group.signerId !== field.signerId ||
        group.required !== field.required
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "The buttons in a radio group must have the same signer and be required or optional together",
          path: [index, "groupId"],
        });
      }

      if (group.count === MAX_RADIO_GROUP_BUTTONS + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `A radio group can have at most ${String(MAX_RADIO_GROUP_BUTTONS)} buttons`,
          path: [index, "groupId"],
        });
      }
    });
  });

export const replaceFieldsSchema = z.object({
  fields: fieldPlacementListSchema,
});

export const replaceFieldsResponseSchema = z.object({
  envelopeId: idSchema,
  fields: z.array(
    fieldPlacementSchema.safeExtend({
      id: idSchema,
    }),
  ),
  redirectPath: z.string().trim().min(1),
  updatedAt: unixTimestampSchema,
});

export const fieldRecordSchema = fieldPlacementSchema.extend({
  inputMethod: fieldInputMethodSchema.nullable().optional(),
  value: optionalTrimmedString(5000).nullable().optional(),
  imageKey: z.string().trim().min(1).nullable().optional(),
  checked: z.boolean().nullable().optional(),
  submittedAt: unixTimestampSchema.nullable().optional(),
  createdAt: unixTimestampSchema,
  updatedAt: unixTimestampSchema,
});

const typedSignatureSubmissionSchema = z.object({
  fieldId: idSchema,
  type: z.enum(["signature", "initials"]),
  inputMethod: z.literal("typed"),
  value: z.string().trim().min(1).max(200),
});

const drawnSignatureSubmissionSchema = z.object({
  fieldId: idSchema,
  type: z.enum(["signature", "initials"]),
  inputMethod: z.literal("drawn"),
  imageDataUrl: z
    .string()
    .trim()
    .min(1)
    .max(
      MAX_DRAWN_SIGNATURE_DATA_URL_LENGTH,
      "Drawn signature image data is too large.",
    ),
});

const textSubmissionSchema = z.object({
  fieldId: idSchema,
  type: z.literal("text"),
  value: z.string().trim().min(1).max(5000),
});

const checkboxSubmissionSchema = z.object({
  fieldId: idSchema,
  type: z.literal("checkbox"),
  checked: z.boolean(),
});

// Whether what was typed is a number, and whether what was chosen is one of
// the field's choices, is checked against the field when it is submitted.
const numberSubmissionSchema = z.object({
  fieldId: idSchema,
  type: z.literal("number"),
  value: z.string().trim().min(1).max(MAX_NUMBER_ENTRY_LENGTH),
});

const dropdownSubmissionSchema = z.object({
  fieldId: idSchema,
  type: z.literal("dropdown"),
  value: z.string().trim().min(1).max(MAX_FIELD_OPTION_LENGTH),
});

const radioSubmissionSchema = z.object({
  fieldId: idSchema,
  type: z.literal("radio"),
  checked: z.boolean(),
});

export const signingFieldSubmissionSchema = z.union([
  typedSignatureSubmissionSchema,
  drawnSignatureSubmissionSchema,
  textSubmissionSchema,
  checkboxSubmissionSchema,
  numberSubmissionSchema,
  dropdownSubmissionSchema,
  radioSubmissionSchema,
]);

export const signingSubmissionSchema = z.object({
  clientTimezoneOffsetMinutes: z.number().int().min(-840).max(840),
  fields: z.array(signingFieldSubmissionSchema),
  // Part 11 envelopes: both parts of the signer's electronic signature,
  // given again for this signature (21 CFR 11.200(a)), and their confirmation
  // of what it means.
  reauthentication: z
    .object({
      email: z.string().trim().min(1).max(320),
      meaningConfirmed: z.literal(true),
      password: z.string().min(1).max(128),
    })
    .optional(),
});

export type FieldPlacement = z.infer<typeof fieldPlacementSchema>;
export type FieldRecord = z.infer<typeof fieldRecordSchema>;
export type ReplaceFieldsInput = z.infer<typeof replaceFieldsSchema>;
export type ReplaceFieldsResponse = z.infer<typeof replaceFieldsResponseSchema>;
export type SigningFieldSubmission = z.infer<
  typeof signingFieldSubmissionSchema
>;
export type SigningSubmission = z.infer<typeof signingSubmissionSchema>;
