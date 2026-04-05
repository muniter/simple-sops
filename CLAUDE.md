# Simple SOPS

VS Code extension for editing SOPS-encrypted files. Decrypts in memory, shows a virtual `sops://` editor, re-encrypts on save. Plaintext never touches disk.

## Architecture

- `src/sops-service.ts` - Core orchestrator. Owns actor lifecycle, IO, machine events, UI logic.
- `src/sops-file-machine.ts` - XState state machine defining the file lifecycle (detecting, encrypted, decrypting, decrypted, encrypting, idle, done).
- `src/sops-fs.ts` - Thin VS Code FileSystemProvider, delegates to the service.
- `src/extension.ts` - Thin VS Code glue. Registers events/commands, forwards to service.
- `src/sops.ts` - SOPS CLI wrapper (decrypt, encrypt via EDITOR trick).
- `src/detect.ts` - File detection (`*.sops.*`, `*.enc.{yaml,yml,json}`, metadata sniffing).
- `src/log.ts` - Output channel logging.

The state machine is the core driver. It emits intent events and the service translates them into VS Code API calls.

## Commands

- `pnpm run compile` - Build with tsgo
- `pnpm run lint` - ESLint + tsgo + knip
- `pnpm test` - Unit tests (mocha, runs without VS Code)
- `pnpm run test:integration` - Integration tests (runs inside VS Code host)
- `pnpm run test:all` - Both

## Testing

Unit tests use mocha + sinon and test the state machine in isolation with mock IO. Integration tests use `@vscode/test-cli` and run inside a VS Code instance against real SOPS-encrypted test fixtures with a committed age key.

## Publishing

Publisher ID is `javierlopez`. Published to the VS Code Marketplace via `npx @vscode/vsce publish --no-dependencies`.
