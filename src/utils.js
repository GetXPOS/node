/**
 * Resolve token from explicit value or XPOS_TOKEN env var.
 * Auto-prepends "tk_" if missing.
 * @param {string|undefined} token
 * @returns {string|null}
 */
export function resolveToken(token) {
  const t = token || process.env.XPOS_TOKEN || null;
  if (!t) return null;
  return t.startsWith("tk_") ? t : `tk_${t}`;
}

/**
 * Build SSH username from token and mode.
 * @param {string|null} token - Resolved token (with tk_ prefix)
 * @param {string} mode - "http" or "tcp"
 * @returns {string}
 */
export function buildSshUser(token, mode) {
  if (!token) return "x";
  return mode === "tcp" ? `${token}+tcp` : token;
}

/**
 * Build the -R remote forward string for SSH.
 * @param {{ port: number, host?: string, subdomain?: string, domain?: string }} opts
 * @returns {string}
 */
export function buildRemoteForward({ port, host = "localhost", subdomain, domain }) {
  if (domain) return `${domain}:80:${host}:${port}`;
  if (subdomain) return `${subdomain}:80:${host}:${port}`;
  return `0:${host}:${port}`;
}

/**
 * Parse HTTPS URL from SSH server output. Falls back to HTTP.
 * @param {string} buffer
 * @returns {string|null}
 */
export function parseUrl(buffer) {
  const https = buffer.match(/HTTPS:\s+(https:\/\/\S+)/i);
  if (https) return https[1];
  const http = buffer.match(/HTTP:\s+(https?:\/\/\S+)/i);
  if (http) return http[1];
  return null;
}

/**
 * Parse port-based tunnel URL (ip:port) from SSH server output.
 * @param {string} buffer
 * @returns {string|null}
 */
export function parsePortUrl(buffer) {
  const match = buffer.match(/tunnel created!\r?\n\s+(\S+:\d+)/i);
  return match ? match[1] : null;
}

/**
 * Parse RFC3339 expiry timestamp from output.
 * @param {string} buffer
 * @returns {string|null}
 */
export function parseExpiry(buffer) {
  const match = buffer.match(/Expires:\s+(\S+)/);
  return match ? match[1] : null;
}

/**
 * Parse error message from output line.
 * @param {string} line
 * @returns {string|null}
 */
export function parseError(line) {
  const match = line.match(/^Error:\s*(.+)/);
  return match ? match[1].trim() : null;
}

/**
 * Format RFC3339 expiry to human-readable string.
 * @param {string} rfc3339
 * @returns {string}
 */
export function formatExpiry(rfc3339) {
  try {
    const expiry = new Date(rfc3339);
    const now = new Date();
    const diffMs = expiry.getTime() - now.getTime();
    if (diffMs <= 0) return "Expired";

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    const hh = String(expiry.getUTCHours()).padStart(2, "0");
    const mm = String(expiry.getUTCMinutes()).padStart(2, "0");

    if (hours > 0) {
      return `Expires in ${hours}h ${minutes}m (${hh}:${mm} UTC)`;
    }
    return `Expires in ${minutes}m (${hh}:${mm} UTC)`;
  } catch {
    return `Expires: ${rfc3339}`;
  }
}

/**
 * Check if an output line should be filtered from pass-through display.
 * @param {string} line
 * @returns {boolean}
 */
export function shouldFilterLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^Tunnel created!/i.test(trimmed)) return true;
  if (/^TCP tunnel created!/i.test(trimmed)) return true;
  if (/^HTTP:/i.test(trimmed)) return true;
  if (/^HTTPS:/i.test(trimmed)) return true;
  if (/^Expires:/i.test(trimmed)) return true;
  if (/^Press Ctrl\+C/i.test(trimmed)) return true;
  if (/^Tunnel closed/i.test(trimmed)) return true;
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(trimmed)) return true;
  return false;
}
