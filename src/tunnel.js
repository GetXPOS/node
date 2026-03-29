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

const DEFAULT_SERVER = "go.xpos.dev";
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
    if (!options.port) throw new Error("port is required");

    this.port = options.port;
    this.host = options.host || "localhost";
    this.token = resolveToken(options.token);
    this.subdomain = options.subdomain || null;
    this.domain = options.domain || null;
    this.mode = options.mode || "http";
    this.server = options.server || DEFAULT_SERVER;
  }

  /**
   * Build SSH command arguments.
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

    return [
      "-p", "443",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
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
  start() {
    return new Promise((resolve, reject) => {
      if (this.connected) {
        reject(new Error("Tunnel is already connected"));
        return;
      }

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
        this.connected = false;
        this._process = null;
        if (!settled) {
          settled = true;
          reject(new Error(`SSH exited with code ${code}`));
        }
        this._emit("close", { code });
      });
    });
  }

  /**
   * Close the tunnel gracefully.
   */
  close() {
    if (!this._process) return;

    const proc = this._process;
    this.connected = false;

    proc.kill("SIGTERM");

    const forceKill = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, KILL_TIMEOUT);

    proc.on("close", () => {
      clearTimeout(forceKill);
      this._process = null;
      this._emit("close", { code: null });
    });
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
