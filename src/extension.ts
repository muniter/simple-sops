import * as vscode from "vscode";
import { SopsService } from "./sops-service.js";
import { SopsFileSystemProvider } from "./sops-fs.js";
import { getSopsBinary } from "./sops.js";
import * as log from "./log.js";

const SOPS_SCHEME = "sops";

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

  const service = new SopsService();
  const fsProvider = new SopsFileSystemProvider(service);
  const statusBar = createStatusBarItem();

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SOPS_SCHEME, fsProvider, {
      isCaseSensitive: true,
      isReadonly: false,
    }),

    vscode.window.registerFileDecorationProvider(new SopsDecorationProvider()),

    vscode.commands.registerCommand("sops.decrypt", (fileUri?: vscode.Uri) =>
      service.handleDecryptCommand(fileUri),
    ),

    vscode.commands.registerCommand("sops.showOutput", () => log.show()),

    vscode.workspace.onDidOpenTextDocument((doc) => service.onDocumentOpened(doc)),

    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed) {
        service.onTabClosed(tab);
      }
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateStatusBar(statusBar, editor);
      if (editor?.document) {
        service.onDocumentOpened(editor.document);
      }
    }),

    statusBar,
  );

  log.info("Extension activated, checking already-open documents...");
  for (const doc of vscode.workspace.textDocuments) {
    service.onDocumentOpened(doc);
  }

  updateStatusBar(statusBar, vscode.window.activeTextEditor);
}

export function deactivate(): void {
  log.info("SOPS Edit extension deactivated");
}

// --- UI components (no logic, just presentation) ---

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
