import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import vsce from "@vscode/vsce";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "..");
const stagePrefix = join(await realpath(tmpdir()), "simple-sops-vsix-");
const { createVSIX, listFiles, PackageManager } = vsce;

async function readOutputPath(args) {
  const normalized = args.filter((arg) => arg !== "--");
  const outIndex = normalized.indexOf("--out");
  if (outIndex === -1) {
    const manifest = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    );
    return resolve(projectRoot, `${manifest.name}-${manifest.version}.vsix`);
  }

  const value = normalized[outIndex + 1];
  if (!value) {
    throw new Error("--out requires a path");
  }

  return isAbsolute(value) ? value : resolve(projectRoot, value);
}

async function copyProjectFiles(stageDir) {
  const files = await listFiles({
    cwd: projectRoot,
    packageManager: PackageManager.None,
  });

  await Promise.all(
    files.map(async (relativePath) => {
      const destination = join(stageDir, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(projectRoot, relativePath), destination);
    }),
  );

  await copyFile(
    join(projectRoot, "pnpm-lock.yaml"),
    join(stageDir, "pnpm-lock.yaml"),
  );
  await copyFile(
    join(projectRoot, ".vscodeignore"),
    join(stageDir, ".vscodeignore"),
  );
}

async function prepareManifest(stageDir) {
  const manifestPath = join(stageDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete manifest.scripts?.["vscode:prepublish"];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function installProductionDependencies(stageDir) {
  await execFileAsync(
    "pnpm",
    [
      "install",
      "--prod",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--config.node-linker=hoisted",
      "--dir",
      stageDir,
    ],
    { cwd: projectRoot },
  );
}

async function main() {
  const outputPath = await readOutputPath(process.argv.slice(2));
  const stageDir = await realpath(await mkdtemp(stagePrefix));

  try {
    await copyProjectFiles(stageDir);
    await prepareManifest(stageDir);
    await installProductionDependencies(stageDir);
    await mkdir(dirname(outputPath), { recursive: true });
    await createVSIX({
      cwd: stageDir,
      packagePath: outputPath,
      dependencies: true,
      useYarn: false,
    });
  } finally {
    if (!stageDir.startsWith(stagePrefix)) {
      throw new Error(`Refusing to remove unexpected path: ${stageDir}`);
    }
    await rm(stageDir, { recursive: true, force: true });
  }
}

await main();
