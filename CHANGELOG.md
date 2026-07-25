# Changelog

All notable changes to Simple SOPS will be documented in this file.

## Unreleased

### Fixed

- Include runtime dependencies in the published VSIX so the extension can
  activate after Marketplace installation.

### Added

- Packaged-extension integration tests that install the actual VSIX in an
  isolated VS Code environment.

## [0.0.1] - 2026-04-04

### Added

- Auto-detect SOPS encrypted files (`*.sops.*` and `*.enc.{yaml,yml,json}`)
- Decrypt and open in virtual `sops://` editor
- Save to re-encrypt via `sops edit` with EDITOR trick
- Stale write detection (file changed on disk while editing)
- Configurable action on open: auto-open, prompt, or do-nothing
- Context menu and editor title bar decrypt button
- Status bar indicator for decrypted files
- Environment variable passthrough (`sops.env` setting)
