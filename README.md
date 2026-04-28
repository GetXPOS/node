# getxpos

[![npm](https://img.shields.io/npm/v/getxpos)](https://www.npmjs.com/package/getxpos)
[![license](https://img.shields.io/npm/l/getxpos)](LICENSE)

Node.js SDK for [XPOS](https://xpos.dev) — instant public URLs via SSH tunnels. Zero dependencies.

## Features

- **Zero dependencies** — uses only Node.js built-ins
- **CLI + programmatic API** — use from terminal or embed in your tooling
- **HTTP & TCP tunnels** — expose web apps or any TCP service
- **Anonymous or authenticated** — works instantly, tokens unlock more features
- **Reserved subdomains & custom domains** — with Pro/Business plans

## Quick Start

```bash
# One-off (no install needed)
npx getxpos --port 3000

# Or install globally
npm install -g getxpos
xpos --port 3000
```

## Installation

```bash
# Global (recommended for CLI usage)
npm install -g getxpos

# Project dependency (for programmatic API)
npm install getxpos --save-dev
```

## Authentication

Get a token from [xpos.dev/dashboard/tokens](https://xpos.dev/dashboard/tokens), then either:

```bash
# Pass directly
xpos --port 3000 --token tk_xxx

# Or set environment variable
export XPOS_TOKEN=tk_xxx
xpos --port 3000
```

## CLI Usage

```bash
# Anonymous tunnel (random subdomain, 3hr expiry)
xpos --port 3000

# Authenticated (random subdomain, 10hr expiry)
xpos --port 3000 --token tk_xxx

# Reserved subdomain (Pro+)
xpos --port 3000 --token tk_xxx --subdomain myapp

# Custom domain (Business)
xpos --port 8000 --token tk_xxx --domain tunnel.example.com

# Port-based TCP tunnel (Pro+)
xpos --port 5432 --token tk_xxx --mode tcp
```

### CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--port <port>` | Local port to expose | **(required)** |
| `--host <host>` | Local host to forward | `localhost` |
| `--token <token>` | Auth token (or `XPOS_TOKEN` env) | — |
| `--subdomain <name>` | Reserved subdomain (requires token) | — |
| `--domain <domain>` | Custom domain (requires token) | — |
| `--mode <mode>` | `http` or `tcp` | `http` |
| `--server <host>` | SSH server hostname | `go.xpos.dev` |
| `-h, --help` | Show help | — |
| `-v, --version` | Show version | — |

## Programmatic API

```js
import { xpos } from 'getxpos';

// HTTP tunnel
const tunnel = await xpos.connect({ port: 3000, token: 'tk_xxx' });
console.log(tunnel.url);        // https://abc.xpos.to
console.log(tunnel.expiresAt);  // 2026-03-28T10:30:45Z
tunnel.close();

// Port-based TCP tunnel
const tcp = await xpos.connect({ port: 5432, token: 'tk_xxx', mode: 'tcp' });
console.log(tcp.url);           // myapp.xpos.to:54321
tcp.close();
```

### Named imports

```js
import { connect, XposTunnel } from 'getxpos';

const tunnel = await connect({ port: 3000 });
console.log(tunnel.url);
tunnel.close();
```

### Events

```js
const tunnel = new XposTunnel({ port: 3000 });

tunnel.on('connect', ({ url, expiresAt }) => {
  console.log(`Connected: ${url}`);
});

tunnel.on('output', (text) => {
  // Raw SSH output
});

tunnel.on('close', ({ code }) => {
  console.log('Tunnel closed');
});

await tunnel.start();
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `port` | `number` | Local port to expose **(required)** |
| `host` | `string` | Local host (default: `"localhost"`) |
| `token` | `string` | Auth token (or reads `XPOS_TOKEN` env) |
| `subdomain` | `string` | Reserved subdomain |
| `domain` | `string` | Custom domain |
| `mode` | `string` | `"http"` or `"tcp"` (default: `"http"`) |
| `server` | `string` | SSH server (default: `"go.xpos.dev"`) |

## Requirements

- **Node.js >= 18**
- **SSH client** in PATH (`ssh` command — comes pre-installed on macOS, Linux, and Windows 10+)

## Security

The auth token is passed as the SSH username (`<token>@go.xpos.dev`), so it
briefly appears in the local `ssh` process's argv. On a shared or audited
host other local users may be able to read it via `ps`,
`/proc/<pid>/cmdline`, or system audit logs.

To minimize exposure:

- **Provide the token via the `XPOS_TOKEN` environment variable** rather
  than hard-coding it in source. This keeps it out of source control and
  shell history (the SDK reads `XPOS_TOKEN` automatically when `token` is
  not set).
- **Rotate tokens regularly** and revoke any token you suspect was
  exposed — manage tokens at [xpos.dev/dashboard/tokens](https://xpos.dev/dashboard/tokens).
- **Avoid running on shared multi-user hosts** where untrusted local
  users can inspect process state.

A protocol change to remove argv exposure is on the roadmap.

## Troubleshooting

**"SSH not found"** — Install OpenSSH. On Windows: `Settings > Apps > Optional Features > OpenSSH Client`.

**Connection timeout** — Check your firewall allows outbound connections on port 443.

**"subdomain requires a token"** — Reserved subdomains need a Pro plan. Get a token from your [dashboard](https://xpos.dev/dashboard/tokens).

## Links

- [Website](https://xpos.dev)
- [Dashboard](https://xpos.dev/dashboard)
- [GitHub](https://github.com/getxpos/node)

## License

[MIT](LICENSE)
