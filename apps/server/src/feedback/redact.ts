/**
 * Replaces secret-shaped strings with `[redacted]` before feedback text reaches the model or
 * GitHub (plan R2). People paste error output and config; this catches the common shapes. It is a
 * net, not a guarantee, so the issue also says not to paste secrets.
 */
const PATTERNS: RegExp[] = [
  // PEM private keys, whole block.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Provider keys with a known prefix.
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // `password: hunter2`, `api_key=…`, `token = …`, `secret: …`
  /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
  // Bearer headers.
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g,
]

export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match, ...groups) => {
      // Keep the key name for `key: value` and `Bearer x` shapes; drop only the value.
      const [first, second] = groups as [unknown, unknown]
      if (typeof first === 'string' && typeof second === 'string' && /[:=]/.test(second)) {
        return `${first}${second}[redacted]`
      }
      if (typeof first === 'string' && /^Bearer\s+$/i.test(first)) return `${first}[redacted]`
      return match.startsWith('-----BEGIN') ? '[redacted private key]' : '[redacted]'
    })
  }
  return out
}
