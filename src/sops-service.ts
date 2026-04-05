import * as vscode from "vscode";
import { createActor, type Actor } from "xstate";
import {
  sopsFileMachine,
  type SopsFileConfig,
  type SopsFileEmitted,
  type SopsFileIO,
} from "./sops-file-machine.ts";
import {
  isDefinitelySops,
  isMaybeSops,
  hasSopsMetadata,
  getLanguageId,
} from "./detect.ts";
import { decrypt, encrypt, getEncryptedFileMtime } from "./sops.ts";
import * as log from "./log.ts";

const SOPS_SCHEME = "sops";
type SopsActor = Actor<typeof sopsFileMachine>;

export class SopsService {
  private readonly _actors = new Map<string, SopsActor>();
  private readonly _content = new Map<string, Uint8Array>();
  private readonly _mtimes = new Map<string, number>();

  private readonly _io: SopsFileIO = {
    detect: async (filePath) => {
      if (isDefinitelySops(filePath)) { return true; }
      if (isMaybeSops(filePath)) { return hasSopsMetadata(filePath); }
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
    isTabOpen: (filePath, scheme) => {
      const uri = scheme === "sops"
        ? vscode.Uri.from({ scheme: SOPS_SCHEME, path: filePath })
        : vscode.Uri.file(filePath);
      return this._isTabOpen(uri);
    },
  };

  // --- Actor lifecycle ---

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
      this._handleMachineEvent(event);
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

  isTracked(filePath: string): boolean {
    const actor = this._actors.get(filePath);
    return actor !== undefined && actor.getSnapshot().status === "active";
  }

  matches(filePath: string, state: string | Record<string, string>): boolean {
    const actor = this._actors.get(filePath);
    if (!actor || actor.getSnapshot().status !== "active") {
      return false;
    }
    return actor.getSnapshot().matches(state as never);
  }

  // --- Events from VS Code (forwarded by extension.ts) ---

  sendDecrypt(filePath: string): void {
    this._actors.get(filePath)?.send({ type: "DECRYPT" });
  }

  sendReopen(filePath: string): void {
    this._actors.get(filePath)?.send({ type: "REOPEN" });
  }

  sendDecryptedTabClosed(filePath: string): void {
    log.info(`sendDecryptedTabClosed: ${filePath}`);
    this._actors.get(filePath)?.send({ type: "DECRYPTED_TAB_CLOSED" });
  }

  sendEncryptedTabClosed(filePath: string): void {
    log.info(`sendEncryptedTabClosed: ${filePath}`);
    this._actors.get(filePath)?.send({ type: "ENCRYPTED_TAB_CLOSED" });
  }

  // --- VS Code event handlers ---

  onTabClosed(tab: vscode.Tab): void {
    if (!(tab.input instanceof vscode.TabInputText)) {
      return;
    }
    const uri = tab.input.uri;
    if (uri.scheme === SOPS_SCHEME) {
      log.info(`sops:// tab closed: ${uri.path}`);
      this.sendDecryptedTabClosed(uri.path);
    } else if (uri.scheme === "file") {
      const filePath = uri.fsPath;
      if (this.isTracked(filePath)) {
        log.info(`encrypted tab closed: ${filePath}`);
        this.sendEncryptedTabClosed(filePath);
      }
    }
  }

  onDocumentOpened(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== "file") {
      return;
    }

    const filePath = doc.uri.fsPath;
    if (this.matches(filePath, "decrypted")) {
      return;
    }

    if (this.isTracked(filePath)) {
      return;
    }

    if (!isDefinitelySops(filePath) && !isMaybeSops(filePath)) {
      return;
    }

    const config = this._getConfig();
    if (config.action === "do-nothing") {
      return;
    }

    this.track(filePath, config);
  }

  handleDecryptCommand(fileUri?: vscode.Uri): void {
    if (!fileUri) {
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      if (!activeUri || activeUri.scheme !== "file") {
        vscode.window.showErrorMessage("SOPS: no file selected");
        return;
      }
      fileUri = activeUri;
    }

    const filePath = fileUri.fsPath;

    if (this.matches(filePath, "encrypted") || this.matches(filePath, { decrypting: "failed" }) || this.matches(filePath, "idle")) {
      this.sendDecrypt(filePath);
    } else if (this.matches(filePath, "decrypted")) {
      this.sendReopen(filePath);
    } else if (!this.isTracked(filePath)) {
      this.track(filePath, this._getConfig());
    }
  }

  // --- Filesystem provider support ---

  getContent(filePath: string): Uint8Array | undefined {
    return this._content.get(filePath);
  }

  getContentSize(filePath: string): number | undefined {
    return this._content.get(filePath)?.byteLength;
  }

  async decryptAndBuffer(filePath: string): Promise<Uint8Array> {
    log.info(`decryptAndBuffer: cache miss, decrypting ${filePath}`);
    const plaintext = await decrypt(filePath);
    const data = new TextEncoder().encode(plaintext);
    this._io.writeBuffer(filePath, data, await getEncryptedFileMtime(filePath));
    return data;
  }

  async handleEncrypt(filePath: string, overwrite: boolean): Promise<void> {
    const actor = this._actors.get(filePath);
    if (!actor) {
      throw new Error(`SOPS: no actor for ${filePath}`);
    }

    actor.send({ type: "ENCRYPT", overwrite });

    await new Promise<void>((resolve, reject) => {
      const onEncrypted = actor.on("encrypted", () => {
        cleanup();
        resolve();
      });
      const onAborted = actor.on("encryptAborted", () => {
        cleanup();
        reject(vscode.FileSystemError.FileExists(
          vscode.Uri.from({ scheme: SOPS_SCHEME, path: filePath }),
        ));
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

  // --- Machine event handler ---

  private _handleMachineEvent(event: SopsFileEmitted): void {
    switch (event.type) {
      case "decrypted":
        void this._openDecryptedTab(event.filePath, event.config);
        break;
      case "decryptFailed":
        vscode.window.showErrorMessage(`SOPS decrypt failed: ${event.error}`);
        break;
      case "encrypted": {
        const filename = event.filePath.split("/").pop() ?? "file";
        vscode.window.showInformationMessage(`SOPS: encrypted ${filename}`);
        break;
      }
      case "encryptAborted":
        break;
      case "encryptFailed":
        vscode.window.showErrorMessage(`SOPS encrypt failed: ${event.error}`);
        break;
      case "promptDecrypt":
        void this._promptDecrypt(event.filePath);
        break;
      case "alreadyDecrypted":
        void this._showAlreadyDecryptedNotification(event.filePath);
        break;
    }
  }

  // --- Config ---

  private _getConfig(): SopsFileConfig {
    const config = vscode.workspace.getConfiguration("sops");
    return {
      action: config.get<SopsFileConfig["action"]>("action", "auto-open"),
      encryptedFileTab: config.get<SopsFileConfig["encryptedFileTab"]>(
        "encryptedFileTab",
        "keep",
      ),
    };
  }

  // --- UI helpers ---

  private async _openDecryptedTab(
    filePath: string,
    config: SopsFileConfig,
  ): Promise<void> {
    const sopsUri = vscode.Uri.from({ scheme: SOPS_SCHEME, path: filePath });

    try {
      const doc = await vscode.workspace.openTextDocument(sopsUri);
      await vscode.languages.setTextDocumentLanguage(doc, getLanguageId(filePath));

      if (config.encryptedFileTab === "close") {
        await vscode.window.showTextDocument(doc);
        await this._closeTab(vscode.Uri.file(filePath));
      } else {
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(message);
    }
  }

  private async _promptDecrypt(filePath: string): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      "This is a SOPS encrypted file. Open decrypted view?",
      "Decrypt",
      "Keep encrypted",
    );
    if (choice === "Decrypt") {
      this.sendDecrypt(filePath);
    }
  }

  private async _showAlreadyDecryptedNotification(
    filePath: string,
  ): Promise<void> {
    const sopsUri = vscode.Uri.from({ scheme: SOPS_SCHEME, path: filePath });
    const choice = await vscode.window.showInformationMessage(
      "This file is already open in a decrypted tab.",
      "Go to decrypted",
    );
    if (choice === "Go to decrypted") {
      await this._focusTab(sopsUri);
    }
  }

  private _isTabOpen(uri: vscode.Uri): boolean {
    const uriStr = uri.toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.toString() === uriStr
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private async _focusTab(uri: vscode.Uri): Promise<boolean> {
    const uriStr = uri.toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.toString() === uriStr
        ) {
          const doc = await vscode.workspace.openTextDocument(tab.input.uri);
          await vscode.window.showTextDocument(doc, group.viewColumn);
          return true;
        }
      }
    }
    return false;
  }

  private async _closeTab(uri: vscode.Uri): Promise<void> {
    const uriStr = uri.toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.toString() === uriStr
        ) {
          await vscode.window.tabGroups.close(tab);
          return;
        }
      }
    }
  }
}
