import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "node:path";

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

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const sopsTab = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find(
        (t) =>
          t.input instanceof vscode.TabInputText &&
          t.input.uri.scheme === "sops",
      );

    assert.ok(sopsTab, "A sops:// tab should be open after detection");
  });

  test("close both tabs, reopen encrypted -> fresh decrypt cycle", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const sopsTabsBefore = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter(
        (t) =>
          t.input instanceof vscode.TabInputText &&
          t.input.uri.scheme === "sops",
      );
    assert.strictEqual(sopsTabsBefore.length, 0, "No sops:// tabs should remain");

    const filePath = path.join(fixturesPath, "secrets.sops.yaml");
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const sopsTabsAfter = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter(
        (t) =>
          t.input instanceof vscode.TabInputText &&
          t.input.uri.scheme === "sops",
      );
    assert.strictEqual(sopsTabsAfter.length, 1, "A new sops:// tab should open");

    const sopsUri = (sopsTabsAfter[0].input as vscode.TabInputText).uri;
    const decryptedDoc = await vscode.workspace.openTextDocument(sopsUri);
    const text = decryptedDoc.getText();
    assert.ok(!text.includes("ENC[AES256_GCM"), "Should be decrypted plaintext");
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });
});
