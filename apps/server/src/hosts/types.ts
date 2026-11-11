export interface HostAdapter {
  kind: 'local' | 'forgejo' | 'github'
  /** Idempotent; repositories are private. The URL carries whatever credential git needs. */
  ensureRepo(name: string): Promise<{ cloneUrl: string }>
  /** Tests only; throws when NODE_ENV is production. */
  deleteRepo(name: string): Promise<void>
  /** Idempotent: an existing hook with the same URL is updated, not duplicated. Local: no-op. */
  ensureWebhook(name: string, url: string, secret: string): Promise<void>
  /** Verifies the signature; null for a bad signature, a non-push event, or an unreadable body. */
  parseWebhook(
    headers: Record<string, string>,
    rawBody: string,
    secret: string,
  ): { repo: string; ref: string } | null
  /** Local: no-op. */
  addCollaborator(name: string, username: string): Promise<void>
}
