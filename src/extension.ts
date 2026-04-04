import * as vscode from "vscode";
import { SopsFileSystemProvider } from "./sops-fs.js";
import { getLanguageId, isDefinitelySops, isMaybeSops } from "./detect.js";
import { getSopsBinary } from "./sops.js";
import type { SopsFileConfig, SopsFileEmitted } from "./sops-file-machine.js";
import * as log from "./log.js";

const SOPS_SCHEME = "sops";

let fsProvider: SopsFileSystemProvider;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  context.subscriptions.push(log.init());
  log.info("SOPS Edit extension activating...");

  const sopsBinary = await getSopsBinary();
  if (!sopsBinary) {
    log.error("sops binary not found on PATH");
    vscode.window.showErrorMessage(
      "SOPS binary not found. Install sops and make sure it's on your PATH.",
    );
    return;
  }
  log.info(`Found sops binary at: ${sopsBinary}`);

  fsProvider = new SopsFileSystemProvider();
  fsProvider.onMachineEvent = handleMachineEvent;

  const statusBar = createStatusBarItem();

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SOPS_SCHEME, fsProvider, {
      isCaseSensitive: true,
      isReadonly: false,
    }),

    vscode.window.registerFileDecorationProvider(new SopsDecorationProvider()),

    vscode.commands.registerCommand("sops.decrypt", (fileUri?: vscode.Uri) =>
      handleDecryptCommand(fileUri),
    ),

    vscode.commands.registerCommand("sops.showOutput", () => log.show()),

    vscode.workspace.onDidOpenTextDocument((doc) => onDocumentOpened(doc)),

    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === SOPS_SCHEME) {
        log.info(`sops:// document closed: ${doc.uri.path}`);
        fsProvider.sendClose(doc.uri.path);
      }
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateStatusBar(statusBar, editor);
      // onDidOpenTextDocument doesn't fire when a tab is re-opened for
      // an already-loaded document. Catch that case here.
      if (editor?.document) {
        onDocumentOpened(editor.document);
      }
    }),

    statusBar,
  );

  syncDecryptButtonContext();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("sops.showDecryptButton")) {
        syncDecryptButtonContext();
      }
    }),
  );

  log.info("Extension activated, checking already-open documents...");
  for (const doc of vscode.workspace.textDocuments) {
    onDocumentOpened(doc);
  }

  updateStatusBar(statusBar, vscode.window.activeTextEditor);
}

export function deactivate(): void {
  log.info("SOPS Edit extension deactivated");
}

// --- Machine event handler ---

function handleMachineEvent(event: SopsFileEmitted): void {
  switch (event.type) {
    case "decrypted":
      void openDecryptedTab(event.filePath, event.config);
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
      // Handled by writeFile throwing FileExists — VS Code shows its own dialog
      break;
    case "encryptFailed":
      vscode.window.showErrorMessage(`SOPS encrypt failed: ${event.error}`);
      break;
    case "promptDecrypt":
      void promptDecrypt(event.filePath);
      break;
    case "alreadyDecrypted":
      void showAlreadyDecryptedNotification(event.filePath);
      break;
  }
}

// --- Config ---

function getConfig(): SopsFileConfig {
  const config = vscode.workspace.getConfiguration("sops");
  return {
    action: config.get<SopsFileConfig["action"]>("action", "auto-open"),
    encryptedFileTab: config.get<SopsFileConfig["encryptedFileTab"]>(
      "encryptedFileTab",
      "close",
    ),
  };
}

// --- Event handlers ---

function handleDecryptCommand(fileUri?: vscode.Uri): void {
  if (!fileUri) {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (!activeUri || activeUri.scheme !== "file") {
      vscode.window.showErrorMessage("SOPS: no file selected");
      return;
    }
    fileUri = activeUri;
  }

  const filePath = fileUri.fsPath;

  if (fsProvider.matches(filePath, "encrypted") || fsProvider.matches(filePath, { decrypting: "failed" })) {
    fsProvider.sendDecrypt(filePath);
  } else if (fsProvider.matches(filePath, "decrypted")) {
    fsProvider.sendReopen(filePath);
  } else if (!fsProvider.isTracked(filePath)) {
    fsProvider.track(filePath, getConfig());
  }
}

function onDocumentOpened(doc: vscode.TextDocument): void {
  if (doc.uri.scheme !== "file") {
    return;
  }

  const filePath = doc.uri.fsPath;
  if (fsProvider.matches(filePath, "decrypted")) {
    const sopsUri = vscode.Uri.from({ scheme: SOPS_SCHEME, path: filePath });
    if (isTabOpen(sopsUri)) {
      fsProvider.sendReopen(filePath);
    } else {
      fsProvider.sendClose(filePath);
      fsProvider.track(filePath, getConfig());
    }
    return;
  }

  if (fsProvider.isTracked(filePath)) {
    return;
  }

  // Only track files that could be SOPS
  if (!isDefinitelySops(filePath) && !isMaybeSops(filePath)) {
    return;
  }

  const config = getConfig();
  if (config.action === "do-nothing") {
    return;
  }

  fsProvider.track(filePath, config);
}

// --- UI ---

async function openDecryptedTab(
  filePath: string,
  config: SopsFileConfig,
): Promise<void> {
  const sopsUri = vscode.Uri.from({ scheme: SOPS_SCHEME, path: filePath });

  try {
    const doc = await vscode.workspace.openTextDocument(sopsUri);
    await vscode.languages.setTextDocumentLanguage(doc, getLanguageId(filePath));
    await vscode.window.showTextDocument(doc);

    if (config.encryptedFileTab === "close") {
      await closeTab(vscode.Uri.file(filePath));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(message);
  }
}

async function promptDecrypt(filePath: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "This is a SOPS encrypted file. Open decrypted view?",
    "Decrypt",
    "Keep encrypted",
  );
  if (choice === "Decrypt") {
    fsProvider.sendDecrypt(filePath);
  }
}

async function showAlreadyDecryptedNotification(
  filePath: string,
): Promise<void> {
  const sopsUri = vscode.Uri.from({ scheme: SOPS_SCHEME, path: filePath });
  const choice = await vscode.window.showInformationMessage(
    "This file is already open in a decrypted tab.",
    "Go to decrypted",
  );
  if (choice === "Go to decrypted") {
    await focusTab(sopsUri);
  }
}

function isTabOpen(uri: vscode.Uri): boolean {
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

async function focusTab(uri: vscode.Uri): Promise<boolean> {
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

async function closeTab(uri: vscode.Uri): Promise<void> {
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

class SopsDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(
    uri: vscode.Uri,
  ): vscode.FileDecoration | undefined {
    if (uri.scheme !== SOPS_SCHEME) {
      return undefined;
    }
    return new vscode.FileDecoration(
      "🔓",
      "SOPS Decrypted",
      new vscode.ThemeColor("charts.green"),
    );
  }
}

function syncDecryptButtonContext(): void {
  const show = vscode.workspace
    .getConfiguration("sops")
    .get<boolean>("showDecryptButton", true);
  void vscode.commands.executeCommand(
    "setContext",
    "sops.showDecryptButton",
    show,
  );
}

function createStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  item.command = "sops.showOutput";
  return item;
}

function updateStatusBar(
  item: vscode.StatusBarItem,
  editor: vscode.TextEditor | undefined,
): void {
  if (editor?.document.uri.scheme === SOPS_SCHEME) {
    item.text = "$(lock) SOPS Decrypted";
    item.tooltip = `Decrypted view of ${editor.document.uri.path}`;
    item.show();
  } else {
    item.hide();
  }
}
