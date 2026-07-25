import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";

suite("SOPS Extension Without SOPS", () => {
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
});
