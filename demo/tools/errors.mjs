import { stripVTControlCharacters } from 'node:util';

// Service names come from the call site, not from untrusted response text.
export function getErrorHelp(error, service) {
  if (!service) {
    return { summary: 'The demo could not complete the request.', next: 'Review the details below for an SDK or application error.' };
  }
  const redis = service === 'Redis Agent Memory';
  const key = redis ? 'AGENT_MEMORY_API_KEY' : 'ANTHROPIC_API_KEY';
  let status;
  const codes = new Set();
  for (let cause = error, depth = 0; cause && depth < 3; cause = cause.cause, depth++) {
    const value = cause.statusCode ?? cause.status;
    if (status === undefined && Number.isInteger(value) && value >= 100 && value <= 599) status = value;
    codes.add(cause.code);
    codes.add(cause.name);
  }
  if (redis && codes.has('INVALID_SESSION_EVENT_INPUT')) {
    return { summary: 'Session event validation failed.', next: 'Check the user message or final assistant text in the hook input; no event was written by this hook.' };
  }
  if (redis && codes.has('INVALID_SCOPE')) {
    return { summary: 'Memory scope validation failed.', next: 'Check the configured user/session IDs and ownership of the requested resource.' };
  }
  if (codes.has('AI_LoadAPIKeyError')) {
    return { summary: `The ${service} API key could not be loaded.`, next: `Check ${key} in demo/tools/.env and your shell, then restart the demo.` };
  }
  if (status === 401) {
    return {
      summary: `${service} rejected authentication (HTTP 401).`,
      next: `Check ${key}. Exported shell values override demo/tools/.env; restart after changing it.`,
    };
  }
  if (status === 403) {
    return {
      summary: `${service} denied access (HTTP 403).`,
      next: redis ? 'Check that AGENT_MEMORY_API_KEY has access to AGENT_MEMORY_STORE_ID.'
        : 'Check the API key permissions and access to the configured model.',
    };
  }
  if (status === 404) {
    return {
      summary: `${service} could not find the requested resource (HTTP 404).`,
      next: redis ? 'Check AGENT_MEMORY_URL, AGENT_MEMORY_STORE_ID, and the requested resource ID.'
        : 'Check ANTHROPIC_MODEL and the provider details below for an unavailable model or endpoint.',
    };
  }
  if (status === 429) {
    return { summary: `${service} rate-limited the request (HTTP 429).`, next: 'Wait before sending more requests; check account rate limits if this persists.' };
  }
  if (status >= 500) {
    return {
      summary: `The request to ${service} received HTTP ${status}${status === 503 ? ' (Service Unavailable)' : ' (server error)'}.`,
      next: redis ? 'Check the Redis endpoint and service health before trying again.'
        : 'Check https://status.claude.com and your network/proxy before trying again.',
    };
  }
  if (status === 400 || status === 422) {
    return {
      summary: `${service} rejected the request (HTTP ${status}).`,
      next: redis ? 'Check the error details, request scope, and Redis store configuration.'
        : 'Check the provider details below and ANTHROPIC_MODEL; the message explains why the request was rejected.',
    };
  }
  if (status === 408 || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'TimeoutError'].some(code => codes.has(code))) {
    return { summary: `The request to ${service} timed out.`, next: 'Check connectivity and service availability before trying again.' };
  }
  if (['ENOTFOUND', 'EAI_AGAIN'].some(code => codes.has(code))) {
    return { summary: `The ${service} hostname could not be resolved.`, next: 'Check DNS, network access, and VPN/proxy settings.' };
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'].some(code => codes.has(code))) {
    return { summary: `The connection to ${service} failed.`, next: 'Check network access, VPN/proxy settings, and the connection or certificate error below.' };
  }
  if (codes.has('AbortError')) {
    return { summary: `The request to ${service} was cancelled.`, next: 'Check the cancellation details before submitting another request.' };
  }
  return {
    summary: `The ${service} request failed${status ? ` (HTTP ${status})` : ''}.`,
    next: redis ? 'Check the error details and Redis request scope.' : 'Check the error details and model configuration.',
  };
}

// Print only useful diagnostics, never SDK request/response objects or headers.
export function formatError(error, secrets = []) {
  const redactions = new Set();
  for (const secret of secrets) {
    if (typeof secret !== 'string') continue;
    for (const value of [secret, secret.trim()]) {
      if (!value) continue;
      redactions.add(value);
      try {
        const encoded = encodeURIComponent(value);
        redactions.add(encoded);
        redactions.add(encoded.replace(/%[0-9A-F]{2}/g, part => part.toLowerCase()));
      } catch { /* A malformed credential must not break error reporting. */ }
    }
  }
  const values = [...redactions].sort((left, right) => right.length - left.length);
  const redact = value => values.reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  const clean = (value, limit) => {
    if (typeof value !== 'string') return '';
    const text = redact(stripVTControlCharacters(redact(value))
      .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')).replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  };

  const details = [];
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth < 3 && current != null && !seen.has(current); depth++) {
    seen.add(current);
    if (typeof current !== 'object') {
      details.push(clean(current, 600) || 'Unknown error');
      break;
    }
    const name = clean(current.name, 80) || 'Error';
    const code = clean(current.code, 80);
    const status = current.statusCode ?? current.status;
    const http = Number.isInteger(status) && status >= 100 && status <= 599 ? ` (HTTP ${status})` : '';
    const message = clean(current.message, 600);
    details.push(`${name}${code && code !== name ? ` [${code}]` : ''}${http}${message ? `: ${message}` : ''}`);
    current = current.cause;
  }
  const summary = details.join('; caused by: ') || 'Unknown error';
  return summary.length > 1500 ? `${summary.slice(0, 1499)}…` : summary;
}
