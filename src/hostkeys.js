import { mkdir, readFile, stat, writeFile, rm, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

// Public well-known URL serving the xpos.dev fleet's SSH host key for SDK
// pinning. Hard-coded — only valid for the official fleet.
export const HOST_KEYS_URL = "https://xpos.dev/.well-known/ssh-host-keys";

// hostKeysCacheMaxAgeMs bounds how long an offline SDK can rely on a stale
// cache. Older caches are treated as missing so a rotation eventually
// invalidates local copies even on machines that go offline.
const HOST_KEYS_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Tight inner timeout on the well-known fetch — the SDK's connect timeout
// already runs above this, but a hard inner cap keeps connect latency
// predictable on flaky networks.
const HOST_KEYS_FETCH_TIMEOUT_MS = 5_000;

const CACHE_DIR = join(homedir(), ".xpos");
const CACHE_FILE = join(CACHE_DIR, "host-keys.json");

async function fetchHostKeys() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HOST_KEYS_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(HOST_KEYS_URL, { signal: ctrl.signal });
    if (!resp.ok) {
      throw new Error(`ssh-host-keys: HTTP ${resp.status}`);
    }
    const doc = await resp.json();
    if (!doc || !Array.isArray(doc.keys) || doc.keys.length === 0) {
      throw new Error("ssh-host-keys: empty key list");
    }
    return doc;
  } finally {
    clearTimeout(timer);
  }
}

async function loadCache() {
  let info;
  try {
    info = await stat(CACHE_FILE);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (Date.now() - info.mtimeMs > HOST_KEYS_CACHE_MAX_AGE_MS) {
    return null; // stale — treat as missing
  }
  const raw = await readFile(CACHE_FILE, "utf8");
  const doc = JSON.parse(raw);
  if (!doc || !Array.isArray(doc.keys) || doc.keys.length === 0) {
    return null;
  }
  return doc;
}

async function saveCache(doc) {
  await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CACHE_FILE, JSON.stringify(doc), { mode: 0o600 });
}

// loadOrFetchHostKeys prefers a fresh network fetch (best authority) but
// falls back to the disk cache when offline. Successful fetches refresh the
// cache. Throws when both paths fail — the SDK then refuses to connect.
async function loadOrFetchHostKeys() {
  let fetchErr = null;
  try {
    const doc = await fetchHostKeys();
    saveCache(doc).catch(() => {}); // best-effort
    return doc;
  } catch (err) {
    fetchErr = err;
  }
  const cached = await loadCache();
  if (cached) return cached;
  throw new Error(`fetch ssh host keys: ${fetchErr?.message || fetchErr}`);
}

// verifyHostKeys fails closed before any key is pinned (A14/A15), mirroring the
// Go SDK's verifyHostKeys. For each key: require type / public_key /
// fingerprint_sha256; reject whitespace/control chars in either field
// (known_hosts is line-oriented, so a newline could smuggle an extra
// `* <attacker-key>` wildcard pin line); and re-derive the OpenSSH SHA256
// fingerprint from the public-key blob, throwing on any disagreement with the
// advertised value. Authenticity ultimately comes from TLS to the well-known
// host — this is a defense-in-depth integrity cross-check, not a MITM bypass.
function verifyHostKeys(doc) {
  for (const k of doc.keys) {
    const type = k.type;
    const pub = k.public_key;
    const advertised = k.fingerprint_sha256;
    if (!type || !pub || !advertised) {
      throw new Error("ssh host keys: missing type/public_key/fingerprint_sha256 from server");
    }
    if (/\s/.test(type) || /\s/.test(pub)) {
      throw new Error("ssh host keys: malformed type or public_key shape from server");
    }
    const derived =
      "SHA256:" +
      createHash("sha256")
        .update(Buffer.from(pub, "base64"))
        .digest("base64")
        .replace(/=+$/, "");
    if (derived !== advertised) {
      throw new Error(
        `ssh host key fingerprint mismatch: server-advertised ${advertised} != re-derived ${derived}`,
      );
    }
  }
}

// writeKnownHostsFile creates a per-process known_hosts file in a fresh
// temp directory (mode 0700, file 0600) pinning every key in doc to
// host:port. Caller is responsible for removing the directory when the
// tunnel exits.
async function writeKnownHostsFile(doc, host, port) {
  verifyHostKeys(doc); // fail closed before materialising trust (A14/A15)
  const dir = await mkdtemp(join(tmpdir(), "xpos-"));
  const path = join(dir, "known_hosts");
  const lines = doc.keys
    .map((k) => `[${host}]:${port} ${k.type} ${k.public_key}\n`)
    .join("");
  await writeFile(path, lines, { mode: 0o600 });
  return { path, dir };
}

/**
 * resolveHostKeys returns a per-process known_hosts file path when the
 * caller is connecting to the official fleet (server === DEFAULT_SERVER);
 * returns { path: null } for custom servers so the SDK falls back to the
 * legacy accept-new behaviour. Throws on pinning failure so the SDK can
 * fail closed rather than silently downgrade to TOFU.
 *
 * The returned `cleanup` callback removes the temp directory; callers
 * should invoke it whether the tunnel succeeds or fails.
 */
// Track whether the custom-server warning has fired this process so we
// don't spam stderr on every connect.
let warnedCustomServer = false;

export async function resolveHostKeys({ server, port, defaultServer }) {
  if (server !== defaultServer) {
    if (!warnedCustomServer) {
      console.error(
        `warning: xpos host-key pinning disabled for custom server '${server}'. ` +
          'Verify the fingerprint manually on first connect.'
      );
      warnedCustomServer = true;
    }
    return { path: null, cleanup: async () => {} };
  }
  const doc = await loadOrFetchHostKeys();
  const { path, dir } = await writeKnownHostsFile(doc, server, port);
  const cleanup = async () => {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };
  return { path, cleanup };
}

/** Test helper: wipe the on-disk cache so each test starts from scratch. */
export async function _clearCacheForTests() {
  try {
    await rm(CACHE_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

// Re-export only what the test suite needs to exercise low-level paths.
export const _internals = {
  fetchHostKeys,
  loadCache,
  saveCache,
  writeKnownHostsFile,
  CACHE_FILE,
  HOST_KEYS_CACHE_MAX_AGE_MS,
  // dirname is used by tests that want to `rm -rf` the cache parent.
  cacheDirOf: (p) => dirname(p),
};
