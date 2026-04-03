#!/usr/bin/env node

import { XposTunnel } from "../src/tunnel.js";
import { resolveToken, formatExpiry, shouldFilterLine, parseError } from "../src/utils.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

// ── Color helpers ──────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  cyan: (s) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  gray: (s) => (isTTY ? `\x1b[90m${s}\x1b[0m` : s),
  bold: (s) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s),
};

// ── Arg parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  const raw = argv.slice(2);

  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--version" || arg === "-v") {
      args.version = true;
    } else if (arg.startsWith("--")) {
      const eqIndex = arg.indexOf("=");
      if (eqIndex !== -1) {
        const key = arg.slice(2, eqIndex);
        args[key] = arg.slice(eqIndex + 1);
      } else {
        const key = arg.slice(2);
        const next = raw[i + 1];
        if (next && !next.startsWith("--")) {
          args[key] = next;
          i++;
        } else {
          args[key] = true;
        }
      }
    }
  }

  return args;
}

function showHelp() {
  console.log(`
  ${c.cyan("XPOS Tunnel")} ${c.gray(`v${pkg.version}`)}
  ${c.gray("Instant public URLs via SSH tunnels")}

  ${c.bold("USAGE")}
    ${c.green("xpos")} --port <port> [options]
    ${c.green("npx getxpos")} --port <port> [options]

  ${c.bold("OPTIONS")}
    --port <port>        Local port to expose ${c.red("(required)")}
    --host <host>        Local host ${c.gray("(default: 127.0.0.1)")}
    --token <token>      Auth token ${c.gray("(or set XPOS_TOKEN env)")}
    --subdomain <name>   Reserved subdomain ${c.gray("(Pro+, requires token)")}
    --domain <domain>    Custom domain ${c.gray("(Business, requires token)")}
    --mode <mode>        Tunnel mode: http or tcp ${c.gray("(default: http)")}
    --server <host>      SSH server ${c.gray("(default: go.xpos.dev)")}
    -h, --help           Show this help
    -v, --version        Show version

  ${c.bold("EXAMPLES")}
    ${c.gray("# Anonymous tunnel")}
    ${c.green("xpos")} --port 3000

    ${c.gray("# Authenticated with reserved subdomain")}
    ${c.green("xpos")} --port 3000 --token tk_xxx --subdomain myapp

    ${c.gray("# Port-based TCP tunnel (Pro+)")}
    ${c.green("xpos")} --port 5432 --token tk_xxx --mode tcp

    ${c.gray("# Custom domain (Business)")}
    ${c.green("xpos")} --port 8000 --token tk_xxx --domain tunnel.example.com

  ${c.gray("https://xpos.dev")}
`);
}

// ── Display helpers ────────────────────────────────────────────────────

function displayBanner(opts) {
  const token = resolveToken(opts.token);
  const mode = token ? "Authenticated" : "Anonymous";

  console.log();
  console.log(`  ${c.cyan("XPOS Tunnel")}`);
  console.log(`  ${c.gray("─".repeat(41))}`);
  console.log(`  ${c.gray("Mode:")}       ${mode}`);

  if (opts.subdomain) {
    console.log(`  ${c.gray("Subdomain:")}  ${opts.subdomain}`);
  } else if (opts.domain) {
    console.log(`  ${c.gray("Domain:")}     ${opts.domain}`);
  }

  if (opts.mode === "tcp") {
    console.log(`  ${c.gray("Type:")}       TCP`);
  }

  console.log();
  console.log(`  ${c.gray("Creating tunnel to XPOS...")}`);
  console.log();
}

function displayUrl(url, expiresAt) {
  const padding = 3;
  const inner = `   ${url}   `;
  const width = Math.max(inner.length, 40);
  const padded = inner.padEnd(width);

  console.log(`  ${c.green("┌" + "─".repeat(width) + "┐")}`);
  console.log(`  ${c.green("│")}${c.bold(padded)}${c.green("│")}`);
  console.log(`  ${c.green("└" + "─".repeat(width) + "┘")}`);
  console.log();

  if (expiresAt) {
    console.log(`  ${c.yellow(formatExpiry(expiresAt))}`);
  }

  console.log(`  ${c.gray("Tunnel active. Press Ctrl+C to stop.")}`);
  console.log();
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  if (args.version) {
    console.log(pkg.version);
    process.exit(0);
  }

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // Validate
  const port = parseInt(args.port, 10);
  if (!args.port || isNaN(port) || port < 1 || port > 65535) {
    console.error(`\n  ${c.red("Error:")} --port is required (1-65535)\n`);
    console.error(`  ${c.gray("Usage:")} xpos --port 3000\n`);
    process.exit(1);
  }

  if (args.subdomain && args.domain) {
    console.error(`\n  ${c.red("Error:")} --subdomain and --domain are mutually exclusive\n`);
    process.exit(1);
  }

  const token = resolveToken(args.token);

  if ((args.subdomain || args.domain) && !token) {
    console.error(`\n  ${c.red("Error:")} --${args.subdomain ? "subdomain" : "domain"} requires a token\n`);
    console.error(`  ${c.gray("Set via:")} --token tk_xxx ${c.gray("or")} XPOS_TOKEN=tk_xxx\n`);
    process.exit(1);
  }

  const mode = args.mode || "http";
  if (mode !== "http" && mode !== "tcp") {
    console.error(`\n  ${c.red("Error:")} --mode must be "http" or "tcp"\n`);
    process.exit(1);
  }

  // Display banner
  displayBanner({ token: args.token, subdomain: args.subdomain, domain: args.domain, mode });

  // Create tunnel
  const tunnel = new XposTunnel({
    port,
    host: args.host,
    token: args.token,
    subdomain: args.subdomain,
    domain: args.domain,
    mode,
    server: args.server,
  });

  // Pass-through unfiltered output
  tunnel.on("output", (text) => {
    for (const line of text.split(/\r?\n/)) {
      if (shouldFilterLine(line)) continue;

      const err = parseError(line);
      if (err) {
        console.error(`  ${c.red("Error:")} ${err}`);
      } else {
        console.log(`  ${c.gray(line.trim())}`);
      }
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log(`\n  ${c.gray("Closing tunnel...")}`);
    tunnel.close();
    setTimeout(() => process.exit(0), 1000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Windows: readline interface needed for SIGINT to fire reliably
  if (process.platform === "win32") {
    const rl = await import("node:readline");
    const iface = rl.createInterface({ input: process.stdin });
    iface.on("SIGINT", () => process.emit("SIGINT"));
  }

  try {
    await tunnel.start();
    displayUrl(tunnel.url, tunnel.expiresAt);
  } catch (err) {
    console.error(`\n  ${c.red("Error:")} ${err.message}\n`);
    process.exit(1);
  }

  // Keep alive until SSH exits
  tunnel.on("close", () => {
    console.log(`\n  ${c.gray("Tunnel closed.")}\n`);
    process.exit(0);
  });
}

main();
