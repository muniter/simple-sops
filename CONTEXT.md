# Simple SOPS

Simple SOPS lets people work with encrypted documents through decrypted
editor views without writing plaintext into the workspace.

## Language

**SOPS executable**:
The local SOPS command-line program used to decrypt and re-encrypt documents.
_Avoid_: SOPS binary, SOPS CLI binary

**Encrypted document**:
A workspace file whose protected values and SOPS metadata remain encrypted on
disk.

**Decrypted view**:
An in-memory editor view exposing an encrypted document's plaintext through
the `sops://` scheme.
