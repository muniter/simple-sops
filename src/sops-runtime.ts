import {
  execFile,
  type ExecFileException,
} from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

type SopsExecOptions = {
  env: NodeJS.ProcessEnv;
};

type SopsExecCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

export type SopsExec = (
  command: string,
  args: string[],
  options: SopsExecOptions,
  callback: SopsExecCallback,
) => void;

type SopsRuntimeOptions = {
  getBinaryPath: () => string;
  getEnvironment: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
  exec?: SopsExec;
};

export class SopsUnavailableError extends Error {
  readonly executable: string;
  readonly reason: "invalid-path" | "not-runnable";

  constructor(
    executable: string,
    reason: "invalid-path" | "not-runnable",
    options?: ErrorOptions,
  ) {
    const message = reason === "invalid-path"
      ? `Configured SOPS binary path must be absolute: ${executable}`
      : `SOPS executable is not runnable: ${executable}`;
    super(message, options);
    this.name = "SopsUnavailableError";
    this.executable = executable;
    this.reason = reason;
  }
}

export class SopsOperationError extends Error {
  readonly operation: string;

  constructor(operation: string, detail: string, options?: ErrorOptions) {
    super(`sops ${operation} failed: ${detail}`, options);
    this.name = "SopsOperationError";
    this.operation = operation;
  }
}

const runExecFile: SopsExec = (command, args, options, callback) => {
  execFile(
    command,
    args,
    { ...options, encoding: "utf8" },
    callback,
  );
};

export class SopsRuntime {
  readonly #getBinaryPath: () => string;
  readonly #getEnvironment: (
    extra?: Record<string, string>,
  ) => NodeJS.ProcessEnv;
  readonly #exec: SopsExec;

  constructor(options: SopsRuntimeOptions) {
    this.#getBinaryPath = options.getBinaryPath;
    this.#getEnvironment = options.getEnvironment;
    this.#exec = options.exec ?? runExecFile;
  }

  async checkAvailability(): Promise<void> {
    const command = this.#resolveExecutable();
    await new Promise<void>((resolve, reject) => {
      this.#exec(
        command,
        ["--help"],
        { env: this.#getEnvironment() },
        (error) => {
          if (error) {
            reject(
              new SopsUnavailableError(command, "not-runnable", {
                cause: error,
              }),
            );
            return;
          }
          resolve();
        },
      );
    });
  }

  async decrypt(filePath: string): Promise<string> {
    const { stdout } = await this.#execute(["decrypt", filePath]);
    return stdout;
  }

  async encrypt(filePath: string, plaintext: string): Promise<void> {
    const tempDir = await mkdtemp(join(tmpdir(), "vscode-sops-"));
    const contentFile = join(tempDir, "content");
    const scriptFile = join(tempDir, "editor.sh");

    try {
      await writeFile(contentFile, plaintext);
      await writeFile(scriptFile, `#!/bin/sh\ncat "${contentFile}" > "$1"\n`);
      await chmod(scriptFile, 0o755);
      await this.#execute(
        ["edit", filePath],
        this.#getEnvironment({ EDITOR: scriptFile }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  #execute(
    args: string[],
    env = this.#getEnvironment(),
  ): Promise<{ stdout: string; stderr: string }> {
    const command = this.#resolveExecutable();
    return new Promise((resolve, reject) => {
      this.#exec(
        command,
        args,
        { env },
        (error, stdout, stderr) => {
          if (error) {
            if (error.code === "ENOENT" || error.code === "EACCES") {
              reject(
                new SopsUnavailableError(command, "not-runnable", {
                  cause: error,
                }),
              );
              return;
            }
            reject(
              new SopsOperationError(
                args[0] ?? "command",
                stderr.trim() || error.message,
                { cause: error },
              ),
            );
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  }

  #resolveExecutable(): string {
    const configuredPath = this.#getBinaryPath().trim();
    if (!configuredPath) {
      return "sops";
    }
    if (!isAbsolute(configuredPath)) {
      throw new SopsUnavailableError(configuredPath, "invalid-path");
    }
    return configuredPath;
  }
}
