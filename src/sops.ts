import { stat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import * as vscode from "vscode";
import * as log from "./log.ts";
import { SopsRuntime } from "./sops-runtime.ts";

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

function getSopsBinaryPath(): string {
  return vscode.workspace
    .getConfiguration("sops")
    .get<string>("binaryPath", "");
}

const runtime = new SopsRuntime({
  getBinaryPath: getSopsBinaryPath,
  getEnvironment: getSopsEnv,
});

export function decrypt(filePath: string): Promise<string> {
  return runtime.decrypt(filePath);
}

export function encrypt(
  filePath: string,
  plaintext: string,
): Promise<void> {
  return runtime.encrypt(filePath, plaintext);
}

export function checkSopsAvailability(): Promise<void> {
  return runtime.checkAvailability();
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
