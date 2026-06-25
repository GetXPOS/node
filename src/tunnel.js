import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveToken,
  buildSshUser,
  buildRemoteForwardConfig,
  parseUrl,
  parsePortUrl,
  parseExpiry,
  parseError,
  quoteSSHConfigPath,
  validateDnsName,
  validateSshConfigValue,
} from "./utils.js";
import { resolveHostKeys } from "./hostkeys.js";

export const DEFAULT_SERVER = "go.xpos.dev";
const DEFAULT_SSH_PORT = 443;
const CONNECT_TIMEOUT = 15_000;
const KILL_TIMEOUT = 3_000;
// M1: cap the parse buffer so a post-URL output burst can't grow it unbounded.
const MAX_PARSE_BUFFER = 64 * 1024;
// M1: bounded window (after the URL is seen) to capture a later-chunk `Expires:`
// line before resolving the connect. Small enough to be unnoticeable; resolves
// SUCCESS on timeout when no `Expires:` arrives (paid / no-expiry tiers).
const EXPIRY_WINDOW_MS = 500;

export class XposTunnel {
  /** @type {string|null} HTTPS URL or ip:port for port tunnels */
  url = null;
  /** @type {string|null} RFC3339 expiry timestamp */
  expiresAt = null;
  /** @type {boolean} */
  connected = false;

  /** @type {import("node:child_process").ChildProcess|null} */
  _process = null;
  /** @type {string} */
  _buffer = "";
  /** @type {Map<string, Set<Function>>} */
  _listeners = new Map();

  /**
   * @param {object} options
   * @param {number} options.port - Local port to expose
   * @param {string} [options.host="127.0.0.1"] - Local host to forward
   * @param {string} [options.token] - XPOS token (or reads XPOS_TOKEN env)
   * @param {string} [options.subdomain] - Reserved subdomain (Pro+)
   * @param {string} [options.domain] - Custom domain (Business)
   * @param {string} [options.mode="http"] - "http" or "tcp"
   * @param {string} [options.server] - SSH server hostname
   * @param {number} [options.sshPort=443] - SSH server port (1-65535)
   */
  constructor(options = {}) {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("port is required (1-65535)");
    }

    const sshPort = options.sshPort === undefined ? DEFAULT_SSH_PORT : Number(options.sshPort);
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
      throw new Error("sshPort must be an integer in 1-65535");
    }

    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.token = resolveToken(options.token);
    this.subdomain = options.subdomain || null;
    this.domain = options.domain || null;
    this.mode = options.mode || "http";
    this.server = options.server || DEFAULT_SERVER;
    this.sshPort = sshPort;

    if (this.subdomain && this.domain) {
      throw new Error("subdomain and domain are mutually exclusive");
    }
    if (this.mode !== "http" && this.mode !== "tcp") {
      throw new Error('mode must be "http" or "tcp"');
    }
    if (this.mode === "tcp" && !this.token) {
      throw new Error("tcp mode requires a token");
    }
    if ((this.subdomain || this.domain) && !this.token) {
      throw new Error(`${this.domain ? "domain" : "subdomain"} requires a token`);
    }

    // Reject control / whitespace in any value rendered into ssh_config —
    // ssh_config is line-based, so a stray newline would smuggle a new
    // directive (e.g. ProxyCommand) into the file.
    validateSshConfigValue("server", this.server);
    validateSshConfigValue("host", this.host);
    if (this.subdomain) {
      validateSshConfigValue("subdomain", this.subdomain);
      validateDnsName("subdomain", this.subdomain);
    }
    if (this.domain) {
      validateSshConfigValue("domain", this.domain);
      validateDnsName("domain", this.domain);
    }
    if (this.token) validateSshConfigValue("token", this.token);
  }

  /**
   * Build the ssh_config body for a single Host alias. The token (carried in
   * the `User` directive) lives in this file rather than the command line so
   * `ps`/`/proc/<pid>/cmdline` can't surface it.
   *
   * When connecting to the official xpos.dev fleet (server === DEFAULT_SERVER)
   * the SDK pins the SSH host key it fetched from
   * https://xpos.dev/.well-known/ssh-host-keys via a per-process known_hosts
   * file referenced by `this._knownHostsPath`. For custom servers the
   * known_hosts file is empty/missing and accept-new TOFU is used.
   *
   * `HostKeyAlias` MUST exactly match the marker the host-keys writer uses
   * (`[host]:port`) — a bare `<host>` would not match the pinned line and
   * would cause a verification failure.
   *
   * @returns {string} ssh_config body
   */
  _buildSshConfig() {
    const user = buildSshUser(this.token, this.mode);
    const { bind, target } = buildRemoteForwardConfig({
      port: this.port,
      host: this.host,
      subdomain: this.subdomain,
      domain: this.domain,
    });
    const hostKeyAlias = `[${this.server}]:${this.sshPort}`;
    const knownHostsLine = this._knownHostsPath
      ? `    StrictHostKeyChecking yes\n    UserKnownHostsFile ${quoteSSHConfigPath(this._knownHostsPath)}\n`
      : `    StrictHostKeyChecking accept-new\n    UserKnownHostsFile ${quoteSSHConfigPath("~/.ssh/xpos_known_hosts")}\n`;

    return [
      "Host xpos",
      `    HostName ${this.server}`,
      `    HostKeyAlias ${hostKeyAlias}`,
      `    User ${user}`,
      `    Port ${this.sshPort}`,
      knownHostsLine.trimEnd(),
      "    LogLevel ERROR",
      "    ConnectTimeout 10",
      `    RemoteForward ${bind} ${target}`,
      "",
    ].join("\n");
  }

  /**
   * Spawn SSH process and connect the tunnel.
   * @returns {Promise<string>} Resolves with the tunnel URL
   */
  async start() {
    if (this.connected) {
      throw new Error("Tunnel is already connected");
    }

    this.url = null;
    this.expiresAt = null;
    this._buffer = "";

    // Resolve the SSH host key before spawning ssh. Fail closed: if we cannot
    // produce a pinned known_hosts file (network down AND no fresh disk
    // cache), refuse to connect rather than silently fall back to TOFU.
    // Custom servers skip pinning entirely (returns { path: null }).
    const { path: knownHostsPath, cleanup: cleanupKnownHosts } =
      await resolveHostKeys({
        server: this.server,
        port: this.sshPort,
        defaultServer: DEFAULT_SERVER,
      });
    this._knownHostsPath = knownHostsPath;
    this._cleanupKnownHosts = cleanupKnownHosts;

    // Materialize a per-process ssh_config in a private temp dir. The
    // 0700 dir + 0600 file combination ensures other UIDs can neither
    // list nor read the file even if a later `mkdtempSync` user creates
    // a wider-permissioned sibling.
    let cfgDir;
    let cfgPath;
    try {
      cfgDir = mkdtempSync(join(tmpdir(), "xpos-ssh-"));
      cfgPath = join(cfgDir, "config");
      writeFileSync(cfgPath, this._buildSshConfig(), { mode: 0o600 });
    } catch (err) {
      // A85: this block runs BEFORE the spawn Promise exists, so a throw here
      // (tmpdir unwritable, ENOSPC, EMFILE) would escape start() with the
      // known_hosts dir resolveHostKeys created above never cleaned up. Release
      // it before rethrowing so the per-process dir doesn't leak for the host's
      // lifetime.
      if (this._cleanupKnownHosts) {
        this._cleanupKnownHosts();
        this._cleanupKnownHosts = null;
      }
      throw err;
    }
    this._sshConfigPath = cfgPath;
    this._sshConfigDir = cfgDir;
    const cleanupSshConfig = () => {
      try {
        rmSync(cfgDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    };

    return new Promise((resolve, reject) => {
      const args = ["-F", cfgPath, "xpos"];
      let settled = false;
      let urlFound = false;
      // C14: carry the incomplete trailing line across chunks so an `Error:`
      // split over a read-chunk boundary is still detected.
      let pendingLine = "";
      let expiryTimer = null;

      const proc = spawn("ssh", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      this._process = proc;

      const clearExpiryTimer = () => {
        if (expiryTimer) {
          clearTimeout(expiryTimer);
          expiryTimer = null;
        }
      };

      // N1: SIGTERM-now + an armed SIGKILL fallback so a wedged ssh that ignores
      // SIGTERM can't orphan the child + leak the 0700 temp dir (cleanup lives in
      // the 'close' handler). The 'close' handler clears _forceKill.
      const armForceKill = () => {
        proc.kill("SIGTERM");
        this._forceKill = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // already dead
          }
        }, KILL_TIMEOUT);
      };

      const finishConnect = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearExpiryTimer();
        this.connected = true;
        this._emit("connect", { url: this.url, expiresAt: this.expiresAt });
        resolve(this.url);
      };

      const failConnect = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearExpiryTimer();
        armForceKill();
        reject(new Error(message));
      };

      const timeout = setTimeout(() => {
        failConnect("Connection timed out after 15s");
      }, CONNECT_TIMEOUT);

      const onData = (chunk) => {
        const text = chunk.toString();
        this._emit("output", text); // always forward output to listeners
        if (settled) return; // connected or failed — stop retaining/parsing (bounds memory)

        // C14: cross-chunk error detection. Prepend the carried partial line,
        // scan complete lines, keep the trailing partial for the next chunk.
        const combined = pendingLine + text;
        const lines = combined.split(/\r?\n/);
        pendingLine = lines.pop() ?? "";
        if (pendingLine.length > MAX_PARSE_BUFFER) {
          pendingLine = pendingLine.slice(pendingLine.length - MAX_PARSE_BUFFER);
        }
        for (const line of lines) {
          const err = parseError(line);
          if (err) {
            failConnect(err);
            return;
          }
        }

        // Accumulate for URL/expiry parsing, bounded so a post-URL burst (during
        // the expiry window) can't grow the buffer without limit.
        this._buffer += text;
        if (this._buffer.length > MAX_PARSE_BUFFER) {
          this._buffer = this._buffer.slice(this._buffer.length - MAX_PARSE_BUFFER);
        }

        if (!urlFound) {
          const url = this.mode === "tcp" ? parsePortUrl(this._buffer) : parseUrl(this._buffer);
          if (!url) return;
          urlFound = true;
          this.url = url;
          this.expiresAt = parseExpiry(this._buffer);
          if (this.expiresAt) {
            finishConnect();
          } else {
            // M1: bounded pre-resolve window — the server emits `Expires:` in a
            // SEPARATE write that may land in a later chunk, so don't resolve
            // immediately. Wait briefly to capture it, but resolve SUCCESS on
            // timeout (paid / no-expiry tiers never send `Expires:`).
            expiryTimer = setTimeout(finishConnect, EXPIRY_WINDOW_MS);
          }
          return;
        }

        // urlFound && !settled → inside the bounded expiry window: re-parse
        // expiry only (never re-run parseUrl).
        const exp = parseExpiry(this._buffer);
        if (exp) {
          this.expiresAt = exp;
          finishConnect();
        }
      };

      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);

      proc.on("error", (err) => {
        clearTimeout(timeout);
        clearExpiryTimer();
        // C15: clear the process handle on a spawn error (e.g. ENOENT) so a
        // later close() doesn't kill a dead process / arm a useless SIGKILL.
        this._process = null;
        // Reclaim the per-process known_hosts temp dir on spawn-time
        // errors (e.g. ssh missing). Node guarantees neither 'close'
        // nor 'exit' for some error paths, so we cannot rely on the
        // 'close' handler to clean up.
        if (this._cleanupKnownHosts) {
          const cleanup = this._cleanupKnownHosts;
          this._cleanupKnownHosts = null;
          this._knownHostsPath = null;
          cleanup().catch(() => {});
        }
        cleanupSshConfig();
        this._sshConfigPath = null;
        this._sshConfigDir = null;
        if (!settled) {
          settled = true;
          if (err.code === "ENOENT") {
            reject(new Error("SSH not found. Install OpenSSH and ensure 'ssh' is in your PATH."));
          } else {
            reject(err);
          }
        }
      });

      proc.on("close", (code) => {
        clearTimeout(timeout);
        clearExpiryTimer();
        if (this._forceKill) {
          clearTimeout(this._forceKill);
          this._forceKill = null;
        }
        this.connected = false;
        this._process = null;
        if (this._cleanupKnownHosts) {
          const cleanup = this._cleanupKnownHosts;
          this._cleanupKnownHosts = null;
          this._knownHostsPath = null;
          cleanup().catch(() => {}); // best-effort
        }
        cleanupSshConfig();
        this._sshConfigPath = null;
        this._sshConfigDir = null;
        if (!settled) {
          if (urlFound) {
            // URL already seen — the process closing during the bounded expiry
            // window still counts as a successful connect (matches the prior
            // immediate-resolve behavior); the 'close' emit below signals the
            // disconnect.
            finishConnect();
          } else {
            settled = true;
            reject(new Error(`SSH exited with code ${code}`));
          }
        }
        this._emit("close", { code });
      });
    });
  }

  /**
   * Close the tunnel gracefully. The existing "close" listener registered in
   * start() handles the single emission; we only send SIGTERM and arm a
   * SIGKILL fallback here.
   */
  close() {
    if (!this._process) return;

    const proc = this._process;
    this.connected = false;

    proc.kill("SIGTERM");

    this._forceKill = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, KILL_TIMEOUT);
  }

  /**
   * Add event listener.
   * @param {"connect"|"error"|"close"|"output"} event
   * @param {Function} fn
   */
  on(event, fn) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(fn);
  }

  /**
   * Remove event listener.
   * @param {string} event
   * @param {Function} fn
   */
  off(event, fn) {
    const set = this._listeners.get(event);
    if (set) set.delete(fn);
  }

  /**
   * Emit event to listeners.
   * @param {string} event
   * @param {*} data
   */
  _emit(event, data) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(data);
      } catch {
        // don't let listener errors crash the tunnel
      }
    }
  }
}

/**
 * Create and start a tunnel. Convenience function.
 * @param {object} options - Same as XposTunnel constructor
 * @returns {Promise<XposTunnel>}
 */
export async function connect(options = {}) {
  const tunnel = new XposTunnel(options);
  await tunnel.start();
  return tunnel;
}
