import * as vscode from "vscode";
import { stat } from "node:fs/promises";
import { createActor, type Actor } from "xstate";
import {
  sopsFileMachine,
  type SopsFileConfig,
  type SopsFileEmitted,
  type SopsFileIO,
} from "./sops-file-machine.js";
import {
  isDefinitelySops,
  isMaybeSops,
  hasSopsMetadata,
} from "./detect.js";
import { decrypt, encrypt, getEncryptedFileMtime } from "./sops.js";
import * as log from "./log.js";

const SOPS_SCHEME = "sops";
type SopsActor = Actor<typeof sopsFileMachine>;

export class SopsFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._changeEmitter.event;

  private readonly _actors = new Map<string, SopsActor>();
  private readonly _content = new Map<string, Uint8Array>();
  private readonly _mtimes = new Map<string, number>();

  /** Handler for all machine-emitted events. Set by extension.ts. */
  onMachineEvent: ((event: SopsFileEmitted) => void) | undefined;

  private readonly _io: SopsFileIO = {
    detect: async (filePath) => {
      if (isDefinitelySops(filePath)) return true;
      if (isMaybeSops(filePath)) return hasSopsMetadata(filePath);
      return false;
    },
    decrypt,
    encrypt,
    getEncryptedFileMtime,
    getLastReadMtime: (filePath) => this._mtimes.get(filePath),
    getEditorContent: (filePath) => {
      const sopsUri = vscode.Uri.from({ scheme: SOPS_SCHEME, path: filePath });
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.toString() === sopsUri.toString()) {
          return doc.getText();
        }
      }
      return undefined;
    },
    writeBuffer: (filePath, data, mtime) => {
      this._content.set(filePath, data);
      if (mtime !== undefined) {
        this._mtimes.set(filePath, mtime);
      }
    },
    clearBuffer: (filePath) => {
      this._content.delete(filePath);
      this._mtimes.delete(filePath);
    },
  };

  // --- Actor management ---

  isTracked(filePath: string): boolean {
    const actor = this._actors.get(filePath);
    return actor !== undefined && actor.getSnapshot().status === "active";
  }

  matches(filePath: string, state: string | Record<string, string>): boolean {
    const actor = this._actors.get(filePath);
    if (!actor || actor.getSnapshot().status !== "active") {
      return false;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return actor.getSnapshot().matches(state as any);
  }

  track(filePath: string, config: SopsFileConfig): void {
    const existing = this._actors.get(filePath);
    if (existing && existing.getSnapshot().status === "active") {
      return;
    }

    log.info(`Tracking: ${filePath}`);

    const actor = createActor(sopsFileMachine, {
      input: { filePath, config, io: this._io, log },
    });

    const sub = actor.on("*", (event) => {
      this.onMachineEvent?.(event);
    });

    actor.subscribe({
      complete: () => {
        log.info(`Actor completed: ${filePath}`);
        sub.unsubscribe();
        this._actors.delete(filePath);
      },
    });

    this._actors.set(filePath, actor);
    actor.start();
  }

  sendDecrypt(filePath: string): void {
    this._actors.get(filePath)?.send({ type: "DECRYPT" });
  }

  sendReopen(filePath: string): void {
    this._actors.get(filePath)?.send({ type: "REOPEN" });
  }

  sendClose(filePath: string): void {
    log.info(`sendClose: ${filePath}`);
    const actor = this._actors.get(filePath);
    if (actor) {
      log.info(`sendClose: stopping actor for ${filePath}`);
      actor.stop();
      this._actors.delete(filePath);
    }
    this._io.clearBuffer(filePath);
  }

  // --- FileSystemProvider interface ---

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const realPath = uri.path;

    try {
      const s = await stat(realPath);
      return {
        type: vscode.FileType.File,
        ctime: s.ctimeMs,
        mtime: s.mtimeMs,
        size: this._content.get(realPath)?.byteLength ?? s.size,
      };
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const realPath = uri.path;

    const cached = this._content.get(realPath);
    if (cached) {
      return cached;
    }

    log.info(`readFile: cache miss, decrypting ${realPath}`);
    const plaintext = await decrypt(realPath);
    const data = new TextEncoder().encode(plaintext);
    this._io.writeBuffer(realPath, data, await getEncryptedFileMtime(realPath));
    return data;
  }

  async writeFile(
    uri: vscode.Uri,
    _content: Uint8Array,
    options?: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const realPath = uri.path;
    const actor = this._actors.get(realPath);
    if (!actor) {
      throw new Error(`SOPS: no actor for ${realPath}`);
    }

    actor.send({ type: "ENCRYPT", overwrite: options?.overwrite === true });

    await new Promise<void>((resolve, reject) => {
      const onEncrypted = actor.on("encrypted", () => {
        cleanup();
        resolve();
      });
      const onAborted = actor.on("encryptAborted", () => {
        cleanup();
        reject(vscode.FileSystemError.FileExists(uri));
      });
      const onFailed = actor.on("encryptFailed", (e) => {
        cleanup();
        reject(new Error(e.error));
      });

      function cleanup(): void {
        onEncrypted.unsubscribe();
        onAborted.unsubscribe();
        onFailed.unsubscribe();
      }
    });
  }

  // --- Unsupported operations ---

  readDirectory(): never {
    throw vscode.FileSystemError.NoPermissions("Not supported");
  }

  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions("Not supported");
  }

  delete(): never {
    throw vscode.FileSystemError.NoPermissions("Not supported");
  }

  rename(): never {
    throw vscode.FileSystemError.NoPermissions("Not supported");
  }

}
