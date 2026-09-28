/** Short, single-line diagnostics. Redact before truncation so a secret is never cut into a visible prefix. */
export function logPreview(value: string, secrets: readonly string[] = [], maxCharacters = 160): string {
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
  text = text
    .replace(/\b(?:https?|data):[^\s<>"']+/giu, '[LINK]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gu, '[REDACTED]')
    .replace(/((?:password|passwd|pwd|(?:api|access|secret)[_-]?key|(?:access|refresh)[_-]?token|token|secret|authorization|密码|密钥)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;<>]+)/giu, '$1[REDACTED]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  return chars.length > maxCharacters ? chars.slice(0, maxCharacters - 1).join('') + '…' : text;
}
