import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";

const isSopsTab = (tab: vscode.Tab) =>
  tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === "sops";

function findSopsTab(): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find(isSopsTab);
}

function waitForSopsTab(timeoutMs = 2000): Promise<vscode.Tab> {
  return new Promise((resolve, reject) => {
    const existing = findSopsTab();
    if (existing) {
      resolve(existing);
      return;
    }

    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error("Timed out waiting for decrypted SOPS tab"));
    }, timeoutMs);
    const subscription = vscode.window.tabGroups.onDidChangeTabs((event) => {
      const tab = event.opened.find(isSopsTab);
      if (tab) {
        clearTimeout(timer);
        subscription.dispose();
        resolve(tab);
      }
    });
  });
}

function waitForActiveEditor(
  predicate: (editor: vscode.TextEditor | undefined) => boolean,
  timeoutMs = 2000,
): Promise<vscode.TextEditor> {
  return new Promise((resolve, reject) => {
    if (predicate(vscode.window.activeTextEditor)) {
      resolve(vscode.window.activeTextEditor!);
      return;
    }

    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error("Timed out waiting for active editor"));
    }, timeoutMs);
    const subscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (predicate(editor)) {
        clearTimeout(timer);
        subscription.dispose();
        resolve(editor!);
      }
    });
  });
}

async function assertNoSopsTab(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(
    findSopsTab(),
    undefined,
    "Automatic opening should remain encrypted while the configured binary is unavailable",
  );
}

suite("SOPS Binary Path", () => {
  const fixturesPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const configuration = vscode.workspace.getConfiguration("sops");

  test("recovers after clearing an invalid binary path", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const extension = vscode.extensions.getExtension(
      "javierlopez.simple-sops",
    );
    assert.ok(extension, "Extension should be installed");
    if (process.env.SIMPLE_SOPS_EXPECT_PACKAGED === "1") {
      assert.notStrictEqual(
        path.resolve(extension.extensionPath),
        path.resolve(__dirname, ".."),
        "Test should load the installed VSIX, not the source checkout",
      );
    }
    await extension.activate();

    const missingBinary = path.join(fixturesPath, "missing-sops-binary");
    await configuration.update(
      "binaryPath",
      missingBinary,
      vscode.ConfigurationTarget.Global,
    );

    const filePath = path.join(fixturesPath, "secrets.sops.yaml");
    const document = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(document);
    await assertNoSopsTab();

    await configuration.update(
      "binaryPath",
      "",
      vscode.ConfigurationTarget.Global,
    );
    await vscode.commands.executeCommand("sops.decrypt", document.uri);
    assert.ok(await waitForSopsTab());
  });

  test("reopens an existing decrypted view without a runnable executable", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await configuration.update(
      "binaryPath",
      "",
      vscode.ConfigurationTarget.Global,
    );

    const filePath = path.join(fixturesPath, "secrets.sops.yaml");
    const document = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(document);
    await waitForSopsTab();
    await vscode.window.showTextDocument(document);

    await configuration.update(
      "binaryPath",
      path.join(fixturesPath, "missing-sops-binary"),
      vscode.ConfigurationTarget.Global,
    );

    await vscode.commands.executeCommand("sops.decrypt", document.uri);
    await vscode.commands.executeCommand("notification.acceptPrimaryAction");
    const activeEditor = await waitForActiveEditor(
      (editor) => editor?.document.uri.scheme === "sops",
    );
    assert.strictEqual(activeEditor.document.uri.path, filePath);
  });

  test("rechecks availability after sops.env changes", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await configuration.update(
      "binaryPath",
      "",
      vscode.ConfigurationTarget.Global,
    );
    await configuration.update(
      "env",
      { PATH: path.join(fixturesPath, "missing-bin-directory") },
      vscode.ConfigurationTarget.Global,
    );

    const unavailablePath = path.join(fixturesPath, "secrets.sops.yaml");
    const unavailableDocument = await vscode.workspace.openTextDocument(
      unavailablePath,
    );
    await vscode.window.showTextDocument(unavailableDocument);
    await assertNoSopsTab();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    await configuration.update(
      "env",
      {},
      vscode.ConfigurationTarget.Global,
    );

    const availablePath = path.join(fixturesPath, "config.enc.yaml");
    const availableDocument = await vscode.workspace.openTextDocument(
      availablePath,
    );
    await vscode.window.showTextDocument(availableDocument);
    const sopsTab = await waitForSopsTab();
    assert.strictEqual(
      (sopsTab.input as vscode.TabInputText).uri.path,
      availablePath,
    );
  });

  suiteTeardown(async () => {
    await configuration.update(
      "binaryPath",
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await configuration.update(
      "env",
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
});
