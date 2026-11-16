// From SignuDoc src/lib/services/audit.ts (MIT, see ../LICENSE-SignuDoc).
// Hotsauce keeps the pure parts: the wording of a correction event and the
// hash chain. SignuDoc's Postgres reads and writes are left out; Hotsauce
// keeps the events in the envelope's file in Git.
import { createHash } from "node:crypto";

import { canonicalJson } from "../utils/canonical-json.ts";

export type AuditEventMetadata = Record<string, unknown> | null;

function readMetadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];

  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function formatSignerPerson(name: string | null, email: string | null): string {
  if (name && email) {
    return `${name} <${email}>`;
  }

  return name ?? email ?? "signer";
}

/** Plain words for a signer_corrected audit event, from its stored metadata. */
export function describeSignerCorrectedEvent(
  metadata: Record<string, unknown> | null | undefined,
): string {
  const previousName = readMetadataString(metadata, "previousName");
  const previousEmail = readMetadataString(metadata, "previousEmail");
  const name = readMetadataString(metadata, "signerName");
  const email = readMetadataString(metadata, "signerEmail");
  const sameName =
    previousName !== null && name !== null && previousName === name;
  const sameEmail =
    previousEmail !== null &&
    email !== null &&
    previousEmail.toLowerCase() === email.toLowerCase();

  if (sameName && previousEmail && email) {
    return `Signer email corrected from ${previousEmail} to ${email}`;
  }

  if (sameEmail && previousName && name) {
    return `Signer name corrected from ${previousName} to ${name}`;
  }

  // Recipient certificates strip addresses. Name-only wording still holds;
  // an email-only change has to be named without the addresses themselves.
  if (!previousEmail && !email && previousName && name) {
    return previousName === name
      ? "Signer email was corrected"
      : `Signer name corrected from ${previousName} to ${name}`;
  }

  return `Signer corrected from ${formatSignerPerson(previousName, previousEmail)} to ${formatSignerPerson(name, email)}`;
}

export type ChainedFields = {
  actorEmail: string | null;
  actorType: string;
  createdAt: number;
  envelopeId: string;
  event: string;
  id: string;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
  sequence: number;
  userAgent: string | null;
};

export function computeAuditRowHash(
  previousHash: string | null,
  fields: ChainedFields,
): string {
  return createHash("sha256")
    .update(previousHash ?? "")
    .update("\n")
    .update(canonicalJson(fields))
    .digest("hex");
}

export type AuditChainCheck =
  | { chainedEvents: number; ok: true }
  | { brokenAtSequence: number; chainedEvents: number; ok: false };

export type ChainedEvent = ChainedFields & {
  prevHash: string | null;
  rowHash: string;
};

/**
 * Recomputes a chain and reports the first event that disagrees. SignuDoc's
 * check, reading a list instead of a table.
 */
export function verifyAuditChain(
  events: readonly ChainedEvent[],
): AuditChainCheck {
  let previousHash: string | null = null;
  let expectedSequence = 1;

  for (const row of events) {
    const { prevHash, rowHash, ...fields } = row;

    if (
      row.sequence !== expectedSequence ||
      prevHash !== previousHash ||
      rowHash !== computeAuditRowHash(previousHash, fields)
    ) {
      return {
        brokenAtSequence: expectedSequence,
        chainedEvents: events.length,
        ok: false,
      };
    }

    previousHash = rowHash;
    expectedSequence += 1;
  }

  return { chainedEvents: events.length, ok: true };
}

/** Appends events to a chain, numbering and hashing each one. */
export function chainAuditEvents(
  previous: readonly ChainedEvent[],
  next: readonly Omit<ChainedFields, "sequence">[],
): ChainedEvent[] {
  const out = [...previous];

  for (const fields of next) {
    const last = out.at(-1) ?? null;
    const chained = { ...fields, sequence: out.length + 1 };
    const prevHash = last ? last.rowHash : null;

    out.push({
      ...chained,
      prevHash,
      rowHash: computeAuditRowHash(prevHash, chained),
    });
  }

  return out;
}
