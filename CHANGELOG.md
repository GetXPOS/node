# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Re-derive and verify each SSH host key's SHA256 fingerprint, and reject
  whitespace/control chars in the key fields, before writing `known_hosts` —
  fail-closed against a tampered/buggy well-known response (matches the Go SDK).

### Fixed
- Clean up the per-process `known_hosts` temp dir if ssh_config materialization
  (`mkdtempSync`/`writeFileSync`) throws before the `ssh` process spawns.

### Changed
- README Security section rewritten to match the shipped design (the token is
  written to a `0600` ssh_config `User` directive, not placed on the `ssh` argv).

## [0.1.8] - 2026-05-13

### Added
- Expose `version` named export so callers can introspect the installed SDK version.
- Ship `CHANGELOG.md` in the npm tarball.

## [0.1.7]

### Added
- SSH host-key pinning from the `xpos.dev` `.well-known/ssh-host-keys` endpoint.
- `sshPort` option for custom SSH ports.

### Changed
- Keep auth token out of the SSH argv (write to a temporary `ssh_config` instead).
- Reject control characters and whitespace in `ssh_config` values.
- Validate subdomain/domain as DNS labels client-side.
- Warn when host-key pinning is disabled for a custom server.
- Default `host` to `127.0.0.1` to avoid IPv6 issues on Windows.
- Use `accept-new` SSH host-key checking for TOFU security.

### Fixed
- Double-fire of close event by removing duplicate listener in `close()`.
- Validate `port` is in the 1–65535 range in the tunnel constructor.
- Require token for TCP mode.
- Clean up `known_hosts` temp dir on spawn error.

## [0.1.6]

### Fixed
- Bare `--token` no longer crashes.
- Validation parity with the Python SDK.
- Reset state on restart.
- TCP output filter improvements.

## [0.1.5]

### Fixed
- Ctrl+C not working on Windows.

## [0.1.2]

### Added
- Initial public release.
