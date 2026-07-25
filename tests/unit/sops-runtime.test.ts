import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SopsOperationError,
  SopsRuntime,
  SopsUnavailableError,
  type SopsExec,
} from "../../src/sops-runtime.ts";

describe("SopsRuntime", () => {
  it("discovers sops through PATH when binaryPath is empty", async () => {
    const commands: string[] = [];
    const exec: SopsExec = (command, _args, _options, callback) => {
      commands.push(command);
      callback(null, "", "");
    };
    const runtime = new SopsRuntime({
      getBinaryPath: () => "",
      getEnvironment: () => ({}),
      exec,
    });

    await runtime.checkAvailability();

    assert.deepStrictEqual(commands, ["sops"]);
  });

  it("rejects a relative configured binary path", async () => {
    const runtime = new SopsRuntime({
      getBinaryPath: () => "./bin/sops",
      getEnvironment: () => ({}),
      exec: () => {
        assert.fail("relative binary path must not be executed");
      },
    });

    await assert.rejects(
      runtime.checkAvailability(),
      (error) =>
        error instanceof SopsUnavailableError &&
        error.reason === "invalid-path" &&
        error.executable === "./bin/sops",
    );
  });

  it("classifies a binary that cannot be executed as unavailable", async () => {
    const missing = Object.assign(new Error("spawn ENOENT"), {
      code: "ENOENT",
      cmd: "/missing/sops --help",
    });
    const runtime = new SopsRuntime({
      getBinaryPath: () => "/missing/sops",
      getEnvironment: () => ({}),
      exec: (_command, _args, _options, callback) => {
        callback(missing, "", "");
      },
    });

    await assert.rejects(
      runtime.checkAvailability(),
      (error) =>
        error instanceof SopsUnavailableError &&
        error.reason === "not-runnable" &&
        error.executable === "/missing/sops",
    );
  });

  it("decrypts with the configured absolute binary", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runtime = new SopsRuntime({
      getBinaryPath: () => "/opt/tools/sops",
      getEnvironment: () => ({}),
      exec: (command, args, _options, callback) => {
        calls.push({ command, args });
        callback(null, "plaintext", "");
      },
    });

    const plaintext = await runtime.decrypt("/workspace/secrets.sops.yaml");

    assert.strictEqual(plaintext, "plaintext");
    assert.deepStrictEqual(calls, [{
      command: "/opt/tools/sops",
      args: ["decrypt", "/workspace/secrets.sops.yaml"],
    }]);
  });

  it("keeps a missing executable distinct from a decrypt failure", async () => {
    const missing = Object.assign(new Error("spawn ENOENT"), {
      code: "ENOENT",
      cmd: "sops decrypt",
    });
    const runtime = new SopsRuntime({
      getBinaryPath: () => "",
      getEnvironment: () => ({}),
      exec: (_command, _args, _options, callback) => {
        callback(missing, "", "");
      },
    });

    await assert.rejects(
      runtime.decrypt("/workspace/secrets.sops.yaml"),
      SopsUnavailableError,
    );
  });

  it("classifies a SOPS decrypt error as an operation failure", async () => {
    const failed = Object.assign(new Error("command failed"), {
      code: 1,
      cmd: "sops decrypt",
    });
    const runtime = new SopsRuntime({
      getBinaryPath: () => "",
      getEnvironment: () => ({}),
      exec: (_command, _args, _options, callback) => {
        callback(failed, "", "age key not found");
      },
    });

    await assert.rejects(
      runtime.decrypt("/workspace/secrets.sops.yaml"),
      (error) =>
        error instanceof SopsOperationError &&
        error.operation === "decrypt" &&
        error.message === "sops decrypt failed: age key not found",
    );
  });
});
