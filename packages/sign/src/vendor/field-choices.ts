// The rules for the fields a signer answers by choosing or by typing a
// number: dropdowns, radio buttons and number fields. Shared by the field
// editor, the signing page and the server, so all three agree.

export const MAX_FIELD_OPTIONS = 20;
export const MAX_FIELD_OPTION_LENGTH = 80;
export const MIN_FIELD_OPTIONS = 2;
export const MAX_RADIO_GROUP_BUTTONS = 20;
export const MAX_NUMBER_ENTRY_LENGTH = 40;

export const NUMBER_ENTRY_MESSAGE = "Enter a number, such as 1250 or 12.5.";

// Plain digits with an optional sign and decimal part, or the same with a
// comma between every three digits. A comma used as a decimal mark ("12,5")
// is refused rather than guessed at: read one way it is twelve and a half,
// read the other it is one hundred and twenty-five.
const PLAIN_NUMBER = /^[+-]?\d{1,18}(\.\d{1,10})?$/;
const GROUPED_NUMBER = /^[+-]?\d{1,3}(,\d{3}){1,5}(\.\d{1,10})?$/;

/** True for what a signer may leave in a number field. */
export function isNumberEntry(value: string): boolean {
  const trimmed = value.trim();

  return (
    trimmed.length <= MAX_NUMBER_ENTRY_LENGTH &&
    (PLAIN_NUMBER.test(trimmed) || GROUPED_NUMBER.test(trimmed))
  );
}

/**
 * The choices typed into the editor, one per line: trimmed, with empty
 * lines and repeats dropped, and no more than a dropdown can hold.
 */
export function parseOptionLines(text: string): string[] {
  const options: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const option = line.trim().slice(0, MAX_FIELD_OPTION_LENGTH).trim();

    if (option && !options.includes(option)) {
      options.push(option);
    }

    if (options.length === MAX_FIELD_OPTIONS) {
      break;
    }
  }

  return options;
}

/**
 * What the editor's box for a dropdown's choices should show: the text as
 * it was typed there, for as long as that text still gives the saved
 * choices, and otherwise the saved choices.
 *
 * The box keeps what was typed so that a trailing space or an empty line
 * survives in mid-thought. But the field editor is on the page twice, for
 * narrow and for wide screens, and only one of the two is typed in. What
 * the other one holds goes stale, and it must not be what the sender types
 * on top of after the window changes width.
 */
export function optionsTextToShow(
  typedText: string,
  savedOptions: readonly string[] | null | undefined,
): string {
  const saved = savedOptions ?? [];
  const typed = parseOptionLines(typedText);

  return typed.length === saved.length &&
    typed.every((option, index) => option === saved[index])
    ? typedText
    : saved.join("\n");
}

/** The same for the box that holds a radio button's label. */
export function labelTextToShow(
  typedText: string,
  savedLabel: string | null | undefined,
): string {
  const saved = savedLabel ?? "";

  return typedText.trim() === saved ? typedText : saved;
}

type ChoiceField = {
  groupId?: string | null;
  options?: readonly string[] | null;
  required: boolean;
  signerId: string;
  type: string;
};

export type ChoiceFieldProblem = {
  kind: "dropdown_options" | "radio_group_size";
  signerId: string;
};

/**
 * What still has to be fixed before an envelope can be sent: a dropdown
 * with fewer than two choices, or a radio button on its own. A draft may be
 * saved in either state, because the editor saves as the sender works.
 */
export function findChoiceFieldProblem(
  fields: readonly ChoiceField[],
): ChoiceFieldProblem | null {
  const groupSizes = new Map<string, { count: number; signerId: string }>();

  for (const field of fields) {
    if (
      field.type === "dropdown" &&
      (field.options?.length ?? 0) < MIN_FIELD_OPTIONS
    ) {
      return { kind: "dropdown_options", signerId: field.signerId };
    }

    if (field.type === "radio" && field.groupId) {
      const group = groupSizes.get(field.groupId);

      if (group) {
        group.count += 1;
      } else {
        groupSizes.set(field.groupId, { count: 1, signerId: field.signerId });
      }
    }
  }

  for (const group of groupSizes.values()) {
    if (group.count < MIN_FIELD_OPTIONS) {
      return { kind: "radio_group_size", signerId: group.signerId };
    }
  }

  return null;
}

export function describeChoiceFieldProblem(
  problem: ChoiceFieldProblem,
  signerName: string,
): string {
  return problem.kind === "dropdown_options"
    ? `A dropdown for ${signerName} needs at least two choices. Select it and add them.`
    : `A radio button for ${signerName} is on its own. Add another button to its group, or remove it.`;
}

/**
 * How many things a signer is asked to do, counting a group of radio
 * buttons as one.
 */
export function countAnswerableFields<
  Field extends Pick<ChoiceField, "groupId" | "type">,
>(fields: readonly Field[], counts: (field: Field) => boolean): number {
  const seenGroups = new Set<string>();
  let total = 0;

  for (const field of fields) {
    if (!counts(field)) {
      continue;
    }

    if (field.type === "radio" && field.groupId) {
      if (seenGroups.has(field.groupId)) {
        continue;
      }

      seenGroups.add(field.groupId);
    }

    total += 1;
  }

  return total;
}

export const DROPDOWN_ENTRY_MESSAGE =
  "Choose one of the listed options in each dropdown.";

/**
 * What is wrong with what a signer entered in a number or dropdown field,
 * or null when it can go on the document as it is.
 */
export function describeEntryProblem(
  field: Pick<ChoiceField, "options" | "type">,
  value: string,
): string | null {
  if (field.type === "number" && !isNumberEntry(value)) {
    return NUMBER_ENTRY_MESSAGE;
  }

  if (field.type === "dropdown" && !(field.options ?? []).includes(value)) {
    return DROPDOWN_ENTRY_MESSAGE;
  }

  return null;
}

export type RadioGroupVerdict = "missing" | "ok" | "too_many";

/**
 * Judges the radio buttons group by group: never more than one chosen, and
 * exactly one where the group is required.
 */
export function judgeRadioGroups<Field extends ChoiceField>(
  fields: readonly Field[],
  isChosen: (field: Field) => boolean,
): RadioGroupVerdict {
  const groups = new Map<string, { chosen: number; required: boolean }>();

  for (const field of fields) {
    if (field.type !== "radio" || !field.groupId) {
      continue;
    }

    const group = groups.get(field.groupId) ?? { chosen: 0, required: false };

    group.required ||= field.required;

    if (isChosen(field)) {
      group.chosen += 1;
    }

    groups.set(field.groupId, group);
  }

  let verdict: RadioGroupVerdict = "ok";

  for (const group of groups.values()) {
    if (group.chosen > 1) {
      return "too_many";
    }

    if (group.required && group.chosen === 0) {
      verdict = "missing";
    }
  }

  return verdict;
}
