// Copied from SignuDoc (MIT, Copyright (c) 2026 Nyllon Software); see ../LICENSE-SignuDoc.
/**
 * The capture email driver writes each message to the local outbox instead of
 * sending it, and gives it a message ID with this prefix. Real providers never
 * use it, so an audit row can tell a captured message from a sent one, including
 * rows recorded before this was written down.
 */
export const CAPTURED_MESSAGE_ID_PREFIX = "capture-";

export function isCapturedMessageId(messageId: string): boolean {
  return messageId.startsWith(CAPTURED_MESSAGE_ID_PREFIX);
}
