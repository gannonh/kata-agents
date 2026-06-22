/**
 * Ensures the Electron native binary is present after install.
 * extract-zip (used by electron's postinstall) can hang on Node 24 and leave
 * a partial dist/ without path.txt — this script repairs that state.
 */

import { downloadArtifact } from "@electron/get";
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "node_modules", "electron");

function getPlatformPath(): string {
  const platform = process.env.npm_config_platform || process.platform;

  switch (platform) {
    case "mas":
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "win32":
      return "electron.exe";
    default:
      return "electron";
  }
}

function isElectronInstalled(): boolean {
  if (!existsSync(ELECTRON_DIR)) {
    return true;
  }

  const platformPath = getPlatformPath();
  const electronPath = join(ELECTRON_DIR, "dist", platformPath);
  const pathFile = join(ELECTRON_DIR, "path.txt");

  if (!existsSync(electronPath)) {
    return false;
  }

  try {
    const { version } = JSON.parse(
      readFileSync(join(ELECTRON_DIR, "package.json"), "utf-8"),
    ) as { version: string };
    const distVersion = readFileSync(
      join(ELECTRON_DIR, "dist", "version"),
      "utf-8",
    ).replace(/^v/, "");

    if (distVersion !== version) {
      return false;
    }

    if (readFileSync(pathFile, "utf-8") !== platformPath) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}

function extractZip(zipPath: string, distDir: string): void {
  if (process.platform === "win32") {
    const result = spawnSync("tar", ["-xf", zipPath, "-C", distDir], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(
        `Failed to extract Electron zip (tar exit ${result.status ?? "unknown"})`,
      );
    }
    return;
  }

  const result = spawnSync("unzip", ["-q", zipPath, "-d", distDir], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to extract Electron zip (unzip exit ${result.status ?? "unknown"})`,
    );
  }
}

async function ensureElectron(): Promise<void> {
  if (!existsSync(ELECTRON_DIR)) {
    return;
  }

  const platformPath = getPlatformPath();
  const electronPath = join(ELECTRON_DIR, "dist", platformPath);
  const pathFile = join(ELECTRON_DIR, "path.txt");

  if (existsSync(electronPath) && !existsSync(pathFile)) {
    writeFileSync(pathFile, platformPath, "utf-8");
  }

  if (isElectronInstalled()) {
    return;
  }

  const { version } = JSON.parse(
    readFileSync(join(ELECTRON_DIR, "package.json"), "utf-8"),
  ) as { version: string };
  const distDir = join(ELECTRON_DIR, "dist");

  console.log(`📥 Repairing Electron ${version} binary install...`);

  const zipPath = await downloadArtifact({
    version,
    artifactName: "electron",
    platform: process.env.npm_config_platform || process.platform,
    arch: process.env.npm_config_arch || process.arch,
    checksums: JSON.parse(
      readFileSync(join(ELECTRON_DIR, "checksums.json"), "utf-8"),
    ),
  });

  if (existsSync(distDir)) {
    rmSync(distDir, { recursive: true, force: true });
  }
  mkdirSync(distDir, { recursive: true });
  extractZip(zipPath, distDir);

  const srcTypeDefPath = join(distDir, "electron.d.ts");
  const targetTypeDefPath = join(ELECTRON_DIR, "electron.d.ts");
  if (existsSync(srcTypeDefPath)) {
    renameSync(srcTypeDefPath, targetTypeDefPath);
  }

  writeFileSync(join(ELECTRON_DIR, "path.txt"), platformPath, "utf-8");

  if (!isElectronInstalled()) {
    throw new Error("Electron install verification failed after repair");
  }

  console.log("✅ Electron binary installed");
}

await ensureElectron();
