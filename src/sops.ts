import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import * as vscode from "vscode";
import * as log from "./log.ts";

/** Path-like env vars that should be resolved relative to the workspace root. */
const PATH_ENV_VARS = new Set(["SOPS_AGE_KEY_FILE"]);

function getSopsEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const config = vscode.workspace.getConfiguration("sops");
  const env: Record<string, string | undefined> = { ...process.env };
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // sops.env — user-configured env vars
  const userEnv = config.get<Record<string, string>>("env");
  if (userEnv) {
    for (const [key, value] of Object.entries(userEnv)) {
      // Resolve relative paths for known path env vars
      if (PATH_ENV_VARS.has(key) && !isAbsolute(value) && workspaceRoot) {
        env[key] = join(workspaceRoot, value);
        log.info(`${key}: ${env[key]}`);
      } else {
        env[key] = value;
      }
    }
  }

  // Extra env vars from caller (e.g. EDITOR)
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      env[key] = value;
    }
  }

  return env;
}

export async function decrypt(filepath: string): Promise<string> {
  const env = getSopsEnv();
  return new Promise((resolve, reject) => {
    execFile("sops", ["decrypt", filepath], { env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`sops decrypt failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function encrypt(
  filepath: string,
  plaintext: string,
): Promise<void> {
  // Same EDITOR trick as the Neovim plugin:
  // 1. Write plaintext to a temp file
  // 2. Create a shell script that copies it into the file sops provides
  // 3. Run `EDITOR=<script> sops edit <file>`
  // This lets sops handle all key management (KMS, age, PGP, etc.)

  const tempDir = await mkdtemp(join(tmpdir(), "vscode-sops-"));
  const contentFile = join(tempDir, "content");
  const scriptFile = join(tempDir, "editor.sh");

  try {
    await writeFile(contentFile, plaintext);
    await writeFile(scriptFile, `#!/bin/sh\ncat "${contentFile}" > "$1"\n`);
    await chmod(scriptFile, 0o755);

    const env = getSopsEnv({ EDITOR: scriptFile });

    await new Promise<void>((resolve, reject) => {
      execFile(
        "sops",
        ["edit", filepath],
        { env },
        (error, _stdout, stderr) => {
          if (error) {
            reject(
              new Error(`sops encrypt failed: ${stderr || error.message}`),
            );
            return;
          }
          resolve();
        },
      );
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function getSopsBinary(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("which", ["sops"], (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/** Read the mtime of the real file on disk. */
export async function getEncryptedFileMtime(filepath: string): Promise<number | undefined> {
  try {
    const s = await stat(filepath);
    return s.mtimeMs;
  } catch {
    return undefined;
  }
}
