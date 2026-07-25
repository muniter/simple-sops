# Simple SOPS

VS Code extension for editing SOPS-encrypted files. It decrypts files in
memory, exposes the plaintext through a virtual `sops://` editor, and
re-encrypts on save. Plaintext must never be written to the workspace.

## Runtime approach

- The extension runs directly from TypeScript source using Node's built-in
  type stripping.
- `package.json` points `main` at `src/extension.ts`.
- Keep runtime TypeScript limited to erasable syntax and use explicit `.ts`
  extensions for relative imports.
- `tsconfig.json` is for static checking only; production extension code is
  not emitted or bundled.
- Runtime dependencies are installed into a disposable, hoisted production
  `node_modules` and included by VSCE.

## Architecture

- `src/sops-service.ts` - Core orchestrator. Owns actor lifecycle, I/O,
  machine events, SOPS readiness policy, and UI logic.
- `src/sops-file-machine.ts` - XState machine defining the file lifecycle.
- `src/sops-fs.ts` - Thin VS Code `FileSystemProvider` delegating to the
  service.
- `src/extension.ts` - Thin VS Code glue registering events and commands.
- `src/sops.ts` - VS Code configuration adapter for the SOPS runtime.
- `src/sops-runtime.ts` - Deep process adapter for executable resolution,
  availability, decrypting, and encrypting via the `EDITOR` mechanism.
- `src/detect.ts` - SOPS file detection by filename and metadata.
- `src/log.ts` - Output-channel logging.

The state machine is the core driver. It emits intent events, and the service
translates those intents into VS Code API calls.

## Commands

- `pnpm run watch` - Continuously type-check source and unit tests with
  `tsgo`; emits no JavaScript.
- `pnpm run typecheck` - Type-check runtime/unit code with `tsgo` and
  integration tests with `tsc`; emits no production JavaScript.
- `pnpm run lint` - Run ESLint, type-checking, and Knip.
- `pnpm test` - Run unit tests directly from TypeScript with `node:test`.
- `pnpm run test:integration` - Compile the integration-test harness and run
  it inside a VS Code extension host.
- `pnpm run package` - Build a VSIX from a temporary production dependency
  tree.
- `pnpm run publish:marketplace` - Build the tested package shape and publish
  that VSIX to the Marketplace.
- `pnpm run test:vsix` - Package a VSIX, install it into an isolated VS Code
  test environment, and run the integration suite against the installed
  artifact.
- `pnpm run test:all` - Run unit, development-host integration, and packaged
  VSIX integration tests.

## Testing

Unit tests use `node:test` and Sinon and run directly from `.ts` source.
Integration tests use `@vscode/test-cli` inside a VS Code instance against
real SOPS-encrypted fixtures and the committed test age key.

The packaged test must load the installed VSIX rather than the repository as
the extension under test. This prevents local `node_modules` from masking a
broken release artifact.

## Publishing

Publisher ID: `javierlopez`.

Before publishing, inspect the generated VSIX and verify that:

- `src/**/*.ts` is included;
- production dependencies are included under `node_modules`;
- tests, fixtures, development output, and source maps are excluded; and
- `pnpm run test:vsix` passes against VS Code 1.114.0.
