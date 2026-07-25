import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";

suite("SOPS Extension Without SOPS", () => {
  const fixturesPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  test("registers commands before checking for sops", async () => {
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

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("sops.decrypt"));
    assert.ok(commands.includes("sops.showOutput"));
  });

  test("leaves automatic and explicit decrypt intents encrypted", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const filePath = path.join(fixturesPath, "secrets.sops.yaml");
    const document = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(document);

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.scheme === "sops",
        ),
      false,
    );

    await vscode.commands.executeCommand("sops.decrypt", document.uri);
    assert.strictEqual(
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.scheme === "sops",
        ),
      false,
    );
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
});
