import * as vscode from "vscode";
import { stat } from "node:fs/promises";
import type { SopsService } from "./sops-service.js";

export class SopsFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._changeEmitter.event;

  constructor(private readonly _service: SopsService) {}

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
        size: this._service.getContentSize(realPath) ?? s.size,
      };
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const realPath = uri.path;
    return this._service.getContent(realPath) ?? this._service.decryptAndBuffer(realPath);
  }

  async writeFile(
    uri: vscode.Uri,
    _content: Uint8Array,
    options?: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    await this._service.handleEncrypt(uri.path, options?.overwrite === true);
  }

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
