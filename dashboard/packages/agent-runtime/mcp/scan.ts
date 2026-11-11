/**
 * Static analysers the agent can run over the files a change touches, whatever
 * its shell permission is.
 *
 * A Polaris addition, not upstream. Each analyser is a released binary pinned
 * to one version and one sha256 per architecture, fetched from its project's
 * GitHub release the first time a run asks for it and verified before it is
 * ever made executable. Nothing here goes through a shell: every binary is
 * started with an argument array, in a minimal environment that carries none
 * of the run's credentials, so a repository cannot turn a file name into a
 * command or read a token back out.
 *
 * What is left out, and why: trivy and opengrep need rule or vulnerability
 * databases fetched at run time that the run cannot verify the way it verifies
 * a pinned binary, and the project's own linters (eslint, biome, ruff) belong
 * to the project's own install, which the shell already reaches.
 */

import { type } from "arktype";
import { createHash } from "node:crypto";
import { execute, tool } from "./shared.ts";
import { spawn } from "../utils/subprocess.ts";
import type { ToolContext } from "./server.ts";
import { primaryRepoState } from "../toolState.ts";
import { chmod, copyFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";

export const SCANNER_IDS = ["gitleaks", "shellcheck", "hadolint", "actionlint", "zizmor", "osv-scanner"] as const;
export type ScannerId = (typeof SCANNER_IDS)[number];

type Arch = "x64" | "arm64";

interface Asset {
  url: string;
  sha256: string;
  /** The binary's path inside a .tar.gz; absent when the download is the binary. */
  member?: string;
}

interface Scanner {
  id: ScannerId;
  version: string;
  /** What it looks for, in the words the agent reads. */
  finds: string;
  assets: Record<Arch, Asset>;
  /** Whether a repository-relative path is one this scanner reads. */
  reads: (path: string) => boolean;
  /** The command line after the binary. `files` are absolute. */
  args: (files: string[], scratch: string) => string[];
  /** Files the scanner takes one directory of instead of a list. */
  asDirectory?: boolean;
}

const gh = (repo: string, tag: string, file: string) =>
  `https://github.com/${repo}/releases/download/${tag}/${file}`;

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "Cargo.lock",
  "go.mod",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "requirements.txt",
  "Gemfile.lock",
  "composer.lock",
  "mix.lock",
  "pubspec.lock",
  "packages.lock.json",
  "gradle.lockfile",
  "pom.xml",
]);

const isWorkflow = (path: string) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
const isAction = (path: string) => /(^|\/)action\.ya?ml$/.test(path);

// Versions and digests were read from each project's release page and its
// published checksum file (shellcheck and zizmor publish none, so theirs were
// computed from the downloaded asset).
export const SCANNERS: Record<ScannerId, Scanner> = {
  gitleaks: {
    id: "gitleaks",
    version: "8.30.1",
    finds: "secrets: keys, tokens and passwords committed in the files",
    assets: {
      x64: {
        url: gh("gitleaks/gitleaks", "v8.30.1", "gitleaks_8.30.1_linux_x64.tar.gz"),
        sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
        member: "gitleaks",
      },
      arm64: {
        url: gh("gitleaks/gitleaks", "v8.30.1", "gitleaks_8.30.1_linux_arm64.tar.gz"),
        sha256: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
        member: "gitleaks",
      },
    },
    reads: () => true,
    asDirectory: true,
    // --redact keeps the secret itself out of the agent's context and so out of
    // anything it writes back to the pull request.
    args: ([dir]) => [
      "dir",
      dir ?? ".",
      "--no-banner",
      "--redact",
      "--verbose",
      "--no-color",
      "--max-target-megabytes",
      "1",
    ],
  },
  shellcheck: {
    id: "shellcheck",
    version: "0.11.0",
    finds: "bugs and portability problems in shell scripts",
    assets: {
      x64: {
        url: gh("koalaman/shellcheck", "v0.11.0", "shellcheck-v0.11.0.linux.x86_64.tar.gz"),
        sha256: "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6",
        member: "shellcheck-v0.11.0/shellcheck",
      },
      arm64: {
        url: gh("koalaman/shellcheck", "v0.11.0", "shellcheck-v0.11.0.linux.aarch64.tar.gz"),
        sha256: "68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc",
        member: "shellcheck-v0.11.0/shellcheck",
      },
    },
    reads: (path) => /\.(sh|bash|ksh)$/.test(path),
    args: (files) => ["--format=gcc", ...files],
  },
  hadolint: {
    id: "hadolint",
    version: "2.15.1",
    finds: "Dockerfile mistakes and the shell bugs inside RUN lines",
    assets: {
      x64: {
        url: gh("hadolint/hadolint", "v2.15.1", "hadolint-linux-x86_64"),
        sha256: "c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507",
      },
      arm64: {
        url: gh("hadolint/hadolint", "v2.15.1", "hadolint-linux-arm64"),
        sha256: "f6198ef8090f404dbb771abfee086eb8c48ac177f30da7fd3510aca35b344b5d",
      },
    },
    reads: (path) => /^(Dockerfile|Containerfile)(\.[^/]+)?$/.test(basename(path)) || /\.[Dd]ockerfile$/.test(path),
    args: (files) => ["--no-color", ...files],
  },
  actionlint: {
    id: "actionlint",
    version: "1.7.12",
    finds: "errors in GitHub Actions workflows, including expression and shell bugs",
    assets: {
      x64: {
        url: gh("rhysd/actionlint", "v1.7.12", "actionlint_1.7.12_linux_amd64.tar.gz"),
        sha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
        member: "actionlint",
      },
      arm64: {
        url: gh("rhysd/actionlint", "v1.7.12", "actionlint_1.7.12_linux_arm64.tar.gz"),
        sha256: "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
        member: "actionlint",
      },
    },
    reads: isWorkflow,
    args: (files) => ["-no-color", ...files],
  },
  zizmor: {
    id: "zizmor",
    version: "1.31.1",
    finds: "security problems in GitHub Actions: injection, excessive permissions, unpinned actions",
    assets: {
      x64: {
        url: gh("zizmorcore/zizmor", "v1.31.1", "zizmor-x86_64-unknown-linux-gnu.tar.gz"),
        sha256: "d185f726bdaf92df78273217dfdd24ebcd6b0ef48cf3ce776ff5762b6e138c99",
        member: "zizmor",
      },
      arm64: {
        url: gh("zizmorcore/zizmor", "v1.31.1", "zizmor-aarch64-unknown-linux-gnu.tar.gz"),
        sha256: "37eebbd5762a44f262d94875431b14a6d2402991e90a685113ea97b8b41be833",
        member: "zizmor",
      },
    },
    reads: (path) => isWorkflow(path) || isAction(path),
    // Offline: the online audits would need a GitHub token, and the scanners
    // get none.
    args: (files) => ["--offline", "--format=plain", ...files],
  },
  "osv-scanner": {
    id: "osv-scanner",
    version: "2.7.0",
    finds: "dependencies with known vulnerabilities, from lockfiles",
    assets: {
      x64: {
        url: gh("google/osv-scanner", "v2.7.0", "osv-scanner_linux_amd64"),
        sha256: "160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b",
      },
      arm64: {
        url: gh("google/osv-scanner", "v2.7.0", "osv-scanner_linux_arm64"),
        sha256: "4061ef4c021ed3c47f203b818f337e351336cc5cd67c0274fc36bd1dfc728dd7",
      },
    },
    reads: (path) => LOCKFILES.has(basename(path)),
    args: (files) => ["scan", "source", ...files.flatMap((file) => ["--lockfile", file])],
  },
};

/** The most a scanner's output may add to the agent's context. */
export const OUTPUT_MAX = 15_000;
/** The largest download accepted, well above the biggest asset above. */
const DOWNLOAD_MAX = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const SCAN_TIMEOUT_MS = 300_000;
/** The largest file copied for a directory scanner; bigger ones are not code. */
const COPY_MAX = 1024 * 1024;

/**
 * The paths the agent named, made safe: relative, inside the repository, no
 * parent steps, no duplicates. Anything else is refused by name rather than
 * dropped, so the agent learns it asked for something it cannot have.
 */
export function cleanPaths(paths: readonly string[]): { ok: string[]; refused: string[] } {
  const ok = new Set<string>();
  const refused: string[] = [];
  for (const raw of paths) {
    const path = normalize(raw.trim()).split(sep).join("/").replace(/^\.\//, "");
    if (
      !path ||
      path === "." ||
      isAbsolute(path) ||
      /^[A-Za-z]:/.test(path) ||
      path.split("/").includes("..") ||
      /[\0\r\n]/.test(path)
    ) {
      refused.push(raw);
      continue;
    }
    ok.add(path);
  }
  return { ok: [...ok], refused };
}

/** Which of the paths each scanner reads, for the scanners asked for. */
export function plan(paths: readonly string[], wanted: readonly ScannerId[]): Map<ScannerId, string[]> {
  const out = new Map<ScannerId, string[]>();
  for (const id of wanted) out.set(id, paths.filter((path) => SCANNERS[id].reads(path)));
  return out;
}

/** The scanner's output, with the scratch directory taken out of its paths and
 *  cut to a size the agent can read. */
export function tidy(output: string, scratch: string | null): string {
  const text = scratch ? output.split(`${scratch}/`).join("").split(scratch).join(".") : output;
  return text.length > OUTPUT_MAX ? `${text.slice(0, OUTPUT_MAX)}\n... [cut at ${OUTPUT_MAX} characters]` : text;
}

function archOf(): Arch | null {
  return process.arch === "x64" || process.arch === "arm64" ? process.arch : null;
}

/** Fetch an asset and refuse it unless its digest is the pinned one. */
export async function fetchVerified(asset: Asset, fetcher: typeof fetch = fetch): Promise<Buffer> {
  const response = await fetcher(asset.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`download failed with ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > DOWNLOAD_MAX) throw new Error("download is larger than any pinned asset");
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > DOWNLOAD_MAX) throw new Error("download is larger than any pinned asset");
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== asset.sha256) throw new Error("download does not match its pinned sha256, so it was not run");
  return body;
}

const installs = new Map<string, Promise<string>>();

/** The scanner's binary, downloaded and verified once per run. */
function install(scanner: Scanner, arch: Arch, root: string): Promise<string> {
  const key = `${scanner.id}@${scanner.version}/${arch}`;
  let pending = installs.get(key);
  if (!pending) {
    pending = (async () => {
      const asset = scanner.assets[arch];
      const dir = join(root, `${scanner.id}-${scanner.version}-${arch}`);
      await mkdir(dir, { recursive: true });
      const bin = join(dir, scanner.id);
      const body = await fetchVerified(asset);
      if (asset.member) {
        const archive = join(dir, "download.tar.gz");
        await writeFile(archive, body);
        const unpacked = await spawn({
          cmd: "tar",
          args: ["-xzf", archive, "-C", dir, asset.member],
          env: { PATH: process.env.PATH ?? "" },
          timeout: DOWNLOAD_TIMEOUT_MS,
        });
        if (unpacked.exitCode !== 0) throw new Error(`could not unpack: ${unpacked.stderr.trim()}`);
        if (join(dir, asset.member) !== bin) await rename(join(dir, asset.member), bin);
      } else {
        await writeFile(bin, body);
      }
      await chmod(bin, 0o755);
      return bin;
    })();
    // A failed install is retried by the next call rather than remembered.
    pending.catch(() => installs.delete(key));
    installs.set(key, pending);
  }
  return pending;
}

/** Copy the files a directory scanner reads into a directory of their own, so
 *  it reads those and not the dependencies installed beside them. */
async function stage(repo: string, files: string[], scratch: string): Promise<string[]> {
  const copied: string[] = [];
  for (const file of files) {
    const source = join(repo, file);
    const info = await stat(source).catch(() => null);
    if (!info?.isFile() || info.size > COPY_MAX) continue;
    const target = join(scratch, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    copied.push(file);
  }
  return copied;
}

interface ScanReport {
  scanner: ScannerId;
  version: string;
  finds: string;
  files: number;
  exitCode?: number;
  output?: string;
  skipped?: string;
}

export const RunScannersParams = type({
  paths: type.string
    .array()
    .atLeastLength(1)
    .atMostLength(500)
    .describe("files to scan, relative to the repository root - normally the files the change touches"),
  "scanners?": type
    .enumerated(...SCANNER_IDS)
    .array()
    .describe("which scanners to run; every one that reads any of the files when omitted"),
});

export function RunScannersTool(ctx: ToolContext) {
  return tool({
    name: "run_scanners",
    description: [
      "Run pinned static analysers over repository files and return what they report.",
      ...SCANNER_IDS.map((id) => `- ${id}: ${SCANNERS[id].finds}`),
      "Each runs only on the files it reads. A non-zero exit code usually means findings, not failure.",
      "Report what the change introduced; findings in lines the change did not touch are context, not review comments.",
    ].join("\n"),
    parameters: RunScannersParams,
    execute: execute(async ({ paths, scanners }) => {
      const arch = archOf();
      if (process.platform !== "linux" || !arch) {
        return { error: `scanners are built for Linux on x64 or arm64; this run is ${process.platform}/${process.arch}` };
      }
      const repo = primaryRepoState(ctx.toolState).dir;
      const { ok, refused } = cleanPaths(paths);
      const root = join(ctx.tmpdir, "scanners");
      const reports: ScanReport[] = [];
      let round = 0;
      for (const [id, files] of plan(ok, scanners ?? SCANNER_IDS)) {
        const scanner = SCANNERS[id];
        const base = { scanner: id, version: scanner.version, finds: scanner.finds, files: files.length };
        if (files.length === 0) {
          reports.push({ ...base, skipped: "none of the paths are files it reads" });
          continue;
        }
        try {
          const bin = await install(scanner, arch, root);
          let scratch: string | null = null;
          let targets = files.map((file) => join(repo, file));
          if (scanner.asDirectory) {
            scratch = join(root, `work-${id}-${++round}`);
            await mkdir(scratch, { recursive: true });
            const copied = await stage(repo, files, scratch);
            if (copied.length === 0) {
              reports.push({ ...base, skipped: "none of the paths exist as files under 1 MB" });
              continue;
            }
            targets = [scratch];
          }
          const result = await spawn({
            cmd: bin,
            args: scanner.args(targets, scratch ?? repo),
            cwd: repo,
            // No credentials: the scanners need none, and a token in their
            // environment is a token a malicious config file could print.
            env: { PATH: process.env.PATH ?? "", HOME: root, NO_COLOR: "1" },
            timeout: SCAN_TIMEOUT_MS,
          });
          const output = [result.stdout, result.stderr].filter((part) => part.trim()).join("\n");
          const shown = tidy(scratch ? output : output.split(`${repo}/`).join(""), scratch);
          reports.push({ ...base, exitCode: result.exitCode, output: shown || "(no output)" });
        } catch (error) {
          reports.push({ ...base, skipped: error instanceof Error ? error.message : String(error) });
        }
      }
      return { reports, ...(refused.length ? { refused } : {}) };
    }),
  });
}

