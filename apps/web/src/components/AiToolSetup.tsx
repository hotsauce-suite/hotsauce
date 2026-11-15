import { type ReactNode, useState } from 'react'
import {
  type AccessToken,
  authHeader,
  claudeCodeCommand,
  claudeDesktopConfig,
  codexConfig,
  codexExport,
  cursorConfig,
  mcpUrl,
} from '../api/tokens'
import { secondaryButton } from '../apps/meetings/components/common'
import { product } from '../brand/product'
import { Icon } from './Icon'

export type AiTool =
  | 'claude-code'
  | 'claude-desktop'
  | 'chatgpt'
  | 'grok'
  | 'cursor'
  | 'codex'
  | 'other'

export const AI_TOOLS: { id: AiTool; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude-desktop', label: 'Claude desktop' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'grok', label: 'Grok' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'codex', label: 'Codex' },
  { id: 'other', label: 'Other' },
]

/**
 * A just-made token, shown once, and the steps to connect it: pick the AI tool, see only its
 * steps, with the server's address and the token already filled in.
 */
export function NewToken({
  token,
  origin,
  onDone,
}: {
  token: AccessToken & { token: string }
  origin: string
  onDone: () => void
}) {
  const [tool, setTool] = useState<AiTool>('claude-code')
  return (
    <section
      data-testid="token-created"
      className="mt-6 rounded-xl border border-ember/40 bg-paper-raised/70 p-4"
    >
      <p className="text-sm font-medium text-ink">
        Copy “{token.name}” now. {product()} won’t show it again.
      </p>
      <CopyBlock testId="token-secret" text={token.token} />

      <fieldset className="mt-5" data-testid="ai-tool-picker">
        <legend className="text-sm font-semibold text-ink-soft">Which AI tool?</legend>
        <div className="mt-2 inline-flex flex-wrap gap-1 rounded-xl border border-ash bg-paper-sunk p-1">
          {AI_TOOLS.map((option) => {
            const on = tool === option.id
            return (
              <label
                key={option.id}
                className={`cursor-pointer rounded-lg px-3 py-1.5 text-sm transition-colors has-[:focus-visible]:shadow-[var(--focus-ring)] ${
                  on
                    ? 'bg-paper-raised font-medium text-ink shadow-sm'
                    : 'text-ink-soft hover:text-ink'
                }`}
              >
                <input
                  type="radio"
                  name="ai-tool"
                  value={option.id}
                  checked={on}
                  data-testid={`ai-tool-${option.id}`}
                  onChange={() => setTool(option.id)}
                  className="sr-only"
                />
                {option.label}
              </label>
            )
          })}
        </div>
      </fieldset>

      <div className="mt-4" data-testid="ai-tool-steps">
        <ToolSteps tool={tool} origin={origin} token={token.token} />
      </div>

      <button type="button" onClick={onDone} className={`${secondaryButton} mt-5 h-9`}>
        Done
      </button>
    </section>
  )
}

function ToolSteps({ tool, origin, token }: { tool: AiTool; origin: string; token: string }) {
  switch (tool) {
    case 'claude-code':
      return (
        <Step title="Claude Code">
          <p>Run this once in a terminal:</p>
          <CopyBlock testId="token-command" text={claudeCodeCommand(origin, token)} />
        </Step>
      )
    case 'claude-desktop':
      return (
        <Step title="Claude desktop">
          <p>
            Add this to <Code>claude_desktop_config.json</Code> (Settings → Developer → Edit
            Config), then restart Claude. It needs Node installed.
          </p>
          <CopyBlock testId="token-desktop-config" text={claudeDesktopConfig(origin, token)} />
        </Step>
      )
    case 'cursor':
      return (
        <Step title="Cursor">
          <p>
            Add this to <Code>~/.cursor/mcp.json</Code> (Cursor Settings → MCP → New MCP Server
            opens it). If the file already has servers, add the entry inside its{' '}
            <Code>mcpServers</Code>.
          </p>
          <CopyBlock testId="token-cursor-config" text={cursorConfig(origin, token)} />
        </Step>
      )
    case 'codex':
      return (
        <Step title="Codex">
          <p>
            Add this to <Code>~/.codex/config.toml</Code>:
          </p>
          <CopyBlock testId="token-codex-config" text={codexConfig(origin)} />
          <p className="mt-3">
            Codex reads the token from your environment. Add this line to your shell profile (for
            example <Code>~/.zshrc</Code>), then open a new terminal:
          </p>
          <CopyBlock testId="token-codex-export" text={codexExport(token)} />
        </Step>
      )
    case 'other':
      return (
        <Step title="Another AI tool or a script">
          <p>
            Any tool that connects to a remote MCP server over Streamable HTTP and lets you set a
            header works. Give it this server address:
          </p>
          <CopyBlock testId="token-url" text={mcpUrl(origin)} />
          <p className="mt-3">and this header:</p>
          <CopyBlock testId="token-header" text={authHeader(token)} />
        </Step>
      )
    case 'chatgpt':
    case 'grok':
      return (
        <Step title={tool === 'chatgpt' ? 'ChatGPT' : 'Grok'}>
          <p data-testid="ai-tool-coming-soon">
            <span className="mr-1.5 rounded-full bg-ember-wash px-2 py-0.5 text-xs font-medium text-ember-strong">
              Needs sign-in, coming soon
            </span>
            {tool === 'chatgpt' ? 'ChatGPT' : 'Grok'} connects to apps through a browser sign-in
            rather than a token. {product()} is adding that sign-in; until then, a token can’t
            connect it.
          </p>
        </Step>
      )
  }
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="text-sm text-ink-soft">
      <h4 className="text-sm font-semibold text-ink">{title}</h4>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-xs">{children}</code>
}

function CopyBlock({ text, testId }: { text: string; testId: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () =>
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => {},
    )
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg border border-ash bg-paper-sunk p-2">
      <pre
        data-testid={testId}
        className="min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-ink"
      >
        {text}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy"
        className="shrink-0 rounded-md p-1.5 text-ink-faint hover:bg-paper hover:text-ink"
      >
        <Icon name={copied ? 'check' : 'copy'} className="size-4" />
      </button>
    </div>
  )
}
