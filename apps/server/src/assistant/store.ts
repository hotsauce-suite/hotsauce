import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ulid } from 'ulid'
import type { AssistantUsage, MessageParam } from './model.js'

/** One tool call as the panel shows it. */
export interface ToolView {
  id: string
  name: string
  kind: 'read' | 'write' | 'confirm'
  input: unknown
  status: 'running' | 'done' | 'error' | 'waiting' | 'confirmed' | 'undone'
  undo?: string
}

/** One message as the panel shows it (the API messages hold tool results and thinking too). */
export interface DisplayMessage {
  role: 'user' | 'assistant'
  text: string
  /** The page the member had open when they asked, if they kept it attached. */
  context?: { title: string; space: string; path: string }
  tools?: ToolView[]
  at: string
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface Conversation extends ConversationSummary {
  display: DisplayMessage[]
  messages: MessageParam[]
}

/** The files one write tool call changed: each one's commit before the call (null: it was new). */
export interface UndoRecord {
  id: string
  ownerId: string
  conversationId: string
  changes: Array<{ space: string; path: string; before: string | null; afterBlob: string | null }>
  undoneAt: string | null
}

export interface MonthUsage extends AssistantUsage {
  ownerId: string
  email: string
  name: string
  month: string
  questions: number
  /** Estimated cost in US dollars, from list prices (see pricing.ts). */
  costUsd: number
}

const MIGRATIONS = [
  `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    display TEXT NOT NULL,
    messages TEXT NOT NULL
  );
  CREATE INDEX conversations_owner ON conversations (owner_id, updated_at);
  CREATE TABLE undo_records (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    changes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    undone_at TEXT
  );
  CREATE TABLE usage (
    owner_id TEXT NOT NULL,
    month TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    questions INTEGER NOT NULL DEFAULT 0,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cost_micros INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, month)
  );
  `,
]

const MAX_CONVERSATIONS_LISTED = 200

interface ConversationRow {
  id: string
  owner_id: string
  title: string
  created_at: string
  updated_at: string
  display: string
  messages: string
}

/**
 * The assistant's private state in `DATA_DIR/assistant.sqlite`: each member's conversations, the
 * undo records of the assistant's writes, and monthly usage. It is per-member history like
 * Dictate's, not workspace content: never committed, never indexed, backed up nightly with the
 * other stores. Every read and write is scoped to the owner's user id.
 */
export class AssistantStore {
  readonly #db: Database.Database

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    this.#db = new Database(file)
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('busy_timeout = 5000')
    const version = this.#db.pragma('user_version', { simple: true }) as number
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.#db.exec(MIGRATIONS[v] ?? '')
      this.#db.pragma(`user_version = ${v + 1}`)
    }
  }

  close(): void {
    this.#db.close()
  }

  list(ownerId: string): ConversationSummary[] {
    const rows = this.#db
      .prepare(
        'SELECT id, title, created_at, updated_at FROM conversations WHERE owner_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?',
      )
      .all(ownerId, MAX_CONVERSATIONS_LISTED) as ConversationRow[]
    return rows.map(summaryOf)
  }

  get(ownerId: string, id: string): Conversation | null {
    const row = this.#db
      .prepare('SELECT * FROM conversations WHERE owner_id = ? AND id = ?')
      .get(ownerId, id) as ConversationRow | undefined
    if (!row) return null
    return {
      ...summaryOf(row),
      display: JSON.parse(row.display) as DisplayMessage[],
      messages: JSON.parse(row.messages) as MessageParam[],
    }
  }

  /** Creates the conversation when it doesn't exist yet (the client picks the id). */
  save(ownerId: string, conv: Omit<Conversation, 'createdAt' | 'updatedAt'>, now: Date): void {
    const at = now.toISOString()
    this.#db
      .prepare(
        `INSERT INTO conversations (id, owner_id, title, created_at, updated_at, display, messages)
         VALUES (@id, @owner, @title, @at, @at, @display, @messages)
         ON CONFLICT (id) DO UPDATE SET title = @title, updated_at = @at, display = @display,
           messages = @messages WHERE owner_id = @owner`,
      )
      .run({
        id: conv.id,
        owner: ownerId,
        title: conv.title,
        at,
        display: JSON.stringify(conv.display),
        messages: JSON.stringify(conv.messages),
      })
  }

  /** Whether an id is taken by another member's conversation (ids are global). */
  ownedByOther(ownerId: string, id: string): boolean {
    const row = this.#db.prepare('SELECT owner_id FROM conversations WHERE id = ?').get(id) as
      | { owner_id: string }
      | undefined
    return row !== undefined && row.owner_id !== ownerId
  }

  delete(ownerId: string, id: string): boolean {
    const deleted = this.#db
      .prepare('DELETE FROM conversations WHERE owner_id = ? AND id = ?')
      .run(ownerId, id)
    this.#db
      .prepare('DELETE FROM undo_records WHERE owner_id = ? AND conversation_id = ?')
      .run(ownerId, id)
    return deleted.changes > 0
  }

  addUndo(record: Omit<UndoRecord, 'id' | 'undoneAt'>, now: Date): string {
    const id = ulid()
    this.#db
      .prepare(
        'INSERT INTO undo_records (id, owner_id, conversation_id, changes, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        id,
        record.ownerId,
        record.conversationId,
        JSON.stringify(record.changes),
        now.toISOString(),
      )
    return id
  }

  getUndo(ownerId: string, id: string): UndoRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM undo_records WHERE owner_id = ? AND id = ?')
      .get(ownerId, id) as
      | {
          id: string
          owner_id: string
          conversation_id: string
          changes: string
          undone_at: string | null
        }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      ownerId: row.owner_id,
      conversationId: row.conversation_id,
      changes: JSON.parse(row.changes) as UndoRecord['changes'],
      undoneAt: row.undone_at,
    }
  }

  markUndone(ownerId: string, id: string, now: Date): void {
    this.#db
      .prepare('UPDATE undo_records SET undone_at = ? WHERE owner_id = ? AND id = ?')
      .run(now.toISOString(), ownerId, id)
  }

  addUsage(
    owner: { userId: string; email: string; name: string },
    usage: AssistantUsage,
    costUsd: number,
    now: Date,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO usage (owner_id, month, email, name, questions, input, output, cache_read, cache_write, cost_micros)
         VALUES (@owner, @month, @email, @name, 1, @input, @output, @cacheRead, @cacheWrite, @cost)
         ON CONFLICT (owner_id, month) DO UPDATE SET email = @email, name = @name,
           questions = questions + 1, input = input + @input, output = output + @output,
           cache_read = cache_read + @cacheRead, cache_write = cache_write + @cacheWrite,
           cost_micros = cost_micros + @cost`,
      )
      .run({
        owner: owner.userId,
        month: monthOf(now),
        email: owner.email,
        name: owner.name,
        ...usage,
        cost: Math.round(costUsd * 1_000_000),
      })
  }

  usage(month: string): MonthUsage[] {
    const rows = this.#db
      .prepare('SELECT * FROM usage WHERE month = ? ORDER BY cost_micros DESC, email')
      .all(month) as Array<{
      owner_id: string
      month: string
      email: string
      name: string
      questions: number
      input: number
      output: number
      cache_read: number
      cache_write: number
      cost_micros: number
    }>
    return rows.map((r) => ({
      ownerId: r.owner_id,
      email: r.email,
      name: r.name,
      month: r.month,
      questions: r.questions,
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      costUsd: r.cost_micros / 1_000_000,
    }))
  }

  usageOf(ownerId: string, month: string): MonthUsage | null {
    return this.usage(month).find((u) => u.ownerId === ownerId) ?? null
  }
}

export function monthOf(now: Date): string {
  return now.toISOString().slice(0, 7)
}

function summaryOf(row: ConversationRow): ConversationSummary {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at }
}
