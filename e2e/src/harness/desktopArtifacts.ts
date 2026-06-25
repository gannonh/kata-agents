import { access } from "node:fs/promises";
import { join } from "node:path";

/**
 * Dev launch loads the renderer from Vite (VITE_DEV_SERVER_URL), so the renderer
 * dist is not required. The main + preload bundles must exist for Electron to boot.
 */
const REQUIRED_DEV_ARTIFACTS = [
  "apps/electron/dist/main.cjs",
  "apps/electron/dist/bootstrap-preload.cjs",
] as const;

export async function assertDesktopBuildArtifacts(repoRoot: string): Promise<void> {
  for (const relative of REQUIRED_DEV_ARTIFACTS) {
    const path = join(repoRoot, relative);
    try {
      await access(path);
    } catch {
      throw new Error(
        `desktop-dev launch: missing ${path}. Run "bun run ensure:electron" and "bun run electron:build" before E2E.`,
      );
    }
  }
}
