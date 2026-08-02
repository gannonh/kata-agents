import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_GITHUB_E2E_REPOSITORY =
  "/Volumes/EVO/dev/uat-runs/kata-agents/github-integration";

export interface GitHubPullRequestFixture {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: string;
  readonly baseRefName: string;
  readonly headRefName: string;
}

export interface GitHubE2ERepository {
  readonly sourcePath: string;
  readonly checkoutPath: string;
  readonly remoteUrl: string;
  readonly repoSlug: string;
  readonly baseRef: string;
  findPullRequest(headRef: string): Promise<GitHubPullRequestFixture | null>;
  cleanup(
    branch: string | undefined,
    pullRequestUrl: string | undefined,
  ): Promise<void>;
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    const details = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    const stderr = details.stderr?.trim();
    const stdout = details.stdout?.trim();
    const output = [stderr, stdout].filter(Boolean).join("\n");
    throw new Error(
      `GitHub E2E command failed: ${command} ${args.join(" ")} (exit ${String(details.code ?? "unknown")})${output ? `\n${output}` : ""}`,
    );
  }
}

async function tryCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  try {
    await runCommand(command, args, cwd);
  } catch {
    // Cleanup is best effort. The test reports the primary assertion failure;
    // the fixture directory is still removed below.
  }
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, cwd)).stdout;
}

function resolveRepositoryPath(): string {
  return process.env.KATA_E2E_GIT_REPO?.trim() || DEFAULT_GITHUB_E2E_REPOSITORY;
}

function parseGitHubRepoSlug(remoteUrl: string): string {
  const match = remoteUrl.match(
    /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/i,
  );
  if (!match?.[1]) {
    throw new Error(
      `GitHub E2E fixture: origin must be a GitHub repository URL, got "${remoteUrl}". Set KATA_E2E_GIT_REPO to a suitable checkout or see e2e/README.md.`,
    );
  }
  return match[1];
}

async function readPullRequest(
  checkoutPath: string,
  headRef: string,
): Promise<GitHubPullRequestFixture | null> {
  const { stdout } = await runCommand(
    "gh",
    [
      "pr",
      "list",
      "--head",
      headRef,
      "--json",
      "number,url,title,state,baseRefName,headRefName",
      "--limit",
      "10",
    ],
    checkoutPath,
  );
  const parsed = JSON.parse(stdout || "[]") as GitHubPullRequestFixture[];
  return parsed[0] ?? null;
}

async function cleanupRepository(
  checkoutPath: string,
  branch: string | undefined,
  pullRequestUrl: string | undefined,
): Promise<void> {
  if (pullRequestUrl) {
    await tryCommand(
      "gh",
      [
        "pr",
        "close",
        pullRequestUrl,
        "--delete-branch",
        "--comment",
        "Kata E2E cleanup",
      ],
      checkoutPath,
    );
  }
  if (branch) {
    await tryCommand(
      "git",
      ["push", "origin", "--delete", branch],
      checkoutPath,
    );
    await tryCommand("git", ["branch", "-D", branch], checkoutPath);
  }
  await tryCommand(
    "git",
    ["worktree", "prune", "--expire", "now"],
    checkoutPath,
  );
}

/**
 * Clone the configured UAT checkout into a disposable directory while keeping
 * its GitHub remote. The source checkout and its main branch are never used as
 * the app workspace, so the real push/PR flow cannot alter the UAT checkout.
 */
export async function createGitHubE2ERepository(): Promise<GitHubE2ERepository> {
  const sourcePath = resolveRepositoryPath();
  try {
    await access(sourcePath);
  } catch {
    throw new Error(
      `GitHub E2E fixture: KATA_E2E_GIT_REPO is missing or inaccessible at "${sourcePath}". Set KATA_E2E_GIT_REPO or create the default UAT checkout, then see e2e/README.md.`,
    );
  }

  const remoteUrl = await git(sourcePath, "remote", "get-url", "origin");
  const repoSlug = parseGitHubRepoSlug(remoteUrl);
  const sourceBranch = await git(sourcePath, "branch", "--show-current");
  if (!sourceBranch) {
    throw new Error(
      `GitHub E2E fixture: source checkout "${sourcePath}" is detached. Check out the repository's default branch before running @git; see e2e/README.md.`,
    );
  }

  await runCommand(
    "gh",
    ["auth", "status", "--hostname", "github.com"],
    sourcePath,
  );

  const checkoutPath = await mkdtemp(join(tmpdir(), "kata-agents-github-e2e-"));
  try {
    await runCommand(
      "git",
      ["clone", "--no-local", sourcePath, checkoutPath],
      tmpdir(),
    );
    await git(checkoutPath, "remote", "set-url", "origin", remoteUrl);
    await git(checkoutPath, "fetch", "--prune", "origin");
    const remoteHead = await git(
      checkoutPath,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ).catch(() => `origin/${sourceBranch}`);
    const baseRef = remoteHead.replace(/^origin\//, "");
    await git(
      checkoutPath,
      "checkout",
      "--force",
      "-B",
      baseRef,
      `origin/${baseRef}`,
    );
    await git(checkoutPath, "config", "user.name", "Kata E2E");
    await git(checkoutPath, "config", "user.email", "kata-e2e@example.com");
    if (await git(checkoutPath, "status", "--porcelain")) {
      throw new Error(
        `GitHub E2E fixture: cloned checkout "${checkoutPath}" is not clean.`,
      );
    }

    return {
      sourcePath,
      checkoutPath,
      remoteUrl,
      repoSlug,
      baseRef,
      findPullRequest: (headRef) => readPullRequest(checkoutPath, headRef),
      cleanup: async (branch, pullRequestUrl) => {
        await cleanupRepository(checkoutPath, branch, pullRequestUrl);
        await rm(checkoutPath, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(checkoutPath, { recursive: true, force: true });
    throw error;
  }
}
