import { spawn } from "node:child_process";
import {
  resolveToken,
  buildSshUser,
  buildRemoteForward,
  parseUrl,
  parsePortUrl,
  parseExpiry,
  parseError,
} from "./utils.js";
import { resolveHostKeys } from "./hostkeys.js";

export const DEFAULT_SERVER = "go.xpos.dev";
const DEFAULT_SSH_PORT = 443;
const CONNECT_TIMEOUT = 15_000;
const KILL_TIMEOUT = 3_000;

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
   * @param {string} [options.host="localhost"] - Local host to forward
   * @param {string} [options.token] - XPOS token (or reads XPOS_TOKEN env)
   * @param {string} [options.subdomain] - Reserved subdomain (Pro+)
   * @param {string} [options.domain] - Custom domain (Business)
   * @param {string} [options.mode="http"] - "http" or "tcp"
   * @param {string} [options.server] - SSH server hostname
   */
  constructor(options = {}) {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("port is required (1-65535)");
    }

    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.token = resolveToken(options.token);
    this.subdomain = options.subdomain || null;
    this.domain = options.domain || null;
    this.mode = options.mode || "http";
    this.server = options.server || DEFAULT_SERVER;

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
  }

  /**
   * Build SSH command arguments.
   *
   * When connecting to the official xpos.dev fleet (server === DEFAULT_SERVER),
   * the SDK pins the SSH host key it fetched from
   * https://xpos.dev/.well-known/ssh-host-keys via a per-process
   * known_hosts file referenced by `this._knownHostsPath`. For custom
   * servers `_knownHostsPath` stays null and the legacy accept-new
   * behaviour is used. The well-known URL is hard-coded to xpos.dev and
   * only valid for that fleet.
   * @returns {string[]}
   */
  _buildArgs() {
    const user = buildSshUser(this.token, this.mode);
    const remoteForward = buildRemoteForward({
      port: this.port,
      host: this.host,
      subdomain: this.subdomain,
      domain: this.domain,
    });

    const hostKeyOpts = this._knownHostsPath
      ? [
          "-o", "StrictHostKeyChecking=yes",
          "-o", `UserKnownHostsFile=${this._knownHostsPath}`,
        ]
      : [
          "-o", "StrictHostKeyChecking=accept-new",
          "-o", "UserKnownHostsFile=~/.ssh/xpos_known_hosts",
        ];

    return [
      "-p", "443",
      ...hostKeyOpts,
      "-o", "LogLevel=ERROR",
      "-o", "ConnectTimeout=10",
      "-R", remoteForward,
      `${user}@${this.server}`,
    ];
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
        port: DEFAULT_SSH_PORT,
        defaultServer: DEFAULT_SERVER,
      });
    this._knownHostsPath = knownHostsPath;
    this._cleanupKnownHosts = cleanupKnownHosts;

    return new Promise((resolve, reject) => {
      const args = this._buildArgs();
      let settled = false;

      const proc = spawn("ssh", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      this._process = proc;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill("SIGTERM");
          reject(new Error("Connection timed out after 15s"));
        }
      }, CONNECT_TIMEOUT);

      const onData = (chunk) => {
        const text = chunk.toString();
        this._buffer += text;
        this._emit("output", text);

        // Check for errors
        for (const line of text.split(/\r?\n/)) {
          const err = parseError(line);
          if (err && !settled) {
            settled = true;
            clearTimeout(timeout);
            proc.kill("SIGTERM");
            reject(new Error(err));
            return;
          }
        }

        // Try to parse URL
        const url = this.mode === "tcp"
          ? parsePortUrl(this._buffer)
          : parseUrl(this._buffer);

        if (url && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.url = url;
          this.expiresAt = parseExpiry(this._buffer);
          this.connected = true;
          this._emit("connect", { url: this.url, expiresAt: this.expiresAt });
          resolve(url);
        }
      };

      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);

      proc.on("error", (err) => {
        clearTimeout(timeout);
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
        if (!settled) {
          settled = true;
          reject(new Error(`SSH exited with code ${code}`));
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
