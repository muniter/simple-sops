import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "node:path";

// --- Test helpers ---

/** Wait for a newly opened tab matching a predicate, or timeout. */
function waitForTab(
  predicate: (tab: vscode.Tab) => boolean,
  timeoutMs = 2000,
): Promise<vscode.Tab> {
  return new Promise((resolve, reject) => {
    // Already open?
    const existing = findTab(predicate);
    if (existing) { resolve(existing); return; }

    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error("Timed out waiting for tab"));
    }, timeoutMs);

    const sub = vscode.window.tabGroups.onDidChangeTabs((e) => {
      const tab = e.opened.find(predicate);
      if (tab) {
        clearTimeout(timer);
        sub.dispose();
        resolve(tab);
      }
    });
  });
}

function findTab(predicate: (tab: vscode.Tab) => boolean): vscode.Tab | undefined {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs).find(predicate);
}

function countTabs(predicate: (tab: vscode.Tab) => boolean): number {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(predicate).length;
}

const isSopsTab = (tab: vscode.Tab) =>
  tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === "sops";

const waitForSopsTab = () => waitForTab(isSopsTab);
const findSopsTab = () => findTab(isSopsTab);
const countSopsTabs = () => countTabs(isSopsTab);

suite("SOPS Extension Integration", () => {
  const fixturesPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  test("extension activates", async () => {
    const ext = vscode.extensions.getExtension("muniter.simple-sops");
    assert.ok(ext, "Extension should be installed");
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test("sops.decrypt command is registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("sops.decrypt"));
  });

  test("sops.showOutput command is registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("sops.showOutput"));
  });

  test("sops:// filesystem provider is registered", async () => {
    const sopsUri = vscode.Uri.from({
      scheme: "sops",
      path: path.join(fixturesPath, "secrets.sops.yaml"),
    });

    try {
      await vscode.workspace.fs.stat(sopsUri);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assert.ok(
        !msg.includes("no provider"),
        "sops:// filesystem provider should be registered",
      );
    }
  });

  test("opening a .sops. file opens a decrypted sops:// tab", async () => {
    const filePath = path.join(fixturesPath, "secrets.sops.yaml");
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    const sopsTab = await waitForSopsTab();
    assert.ok(sopsTab, "A sops:// tab should be open after detection");
  });

  test("close both tabs, reopen encrypted -> fresh decrypt cycle", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    assert.strictEqual(countSopsTabs(), 0, "No sops:// tabs should remain");

    const filePath = path.join(fixturesPath, "secrets.sops.yaml");
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    await waitForSopsTab();

    assert.strictEqual(countSopsTabs(), 1, "A new sops:// tab should open");

    const sopsTab = findSopsTab()!;
    const sopsUri = (sopsTab.input as vscode.TabInputText).uri;
    const decryptedDoc = await vscode.workspace.openTextDocument(sopsUri);
    const text = decryptedDoc.getText();
    assert.ok(!text.includes("ENC[AES256_GCM"), "Should be decrypted plaintext");
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
});
