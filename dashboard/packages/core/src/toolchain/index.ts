/**
 * The tools a "This computer" session needs, provisioned by Polaris itself.
 *
 * The normal computer that runs Polar Code locally has none of git, Node, gh,
 * an agent CLI or Enigma installed, and its owner is not going to open a
 * terminal to fix that. So the desktop app (or any runner) downloads each one
 * into a directory it owns, never system-wide and with no admin rights, checks
 * every byte against a SHA-256 pinned below, and puts that directory first on
 * the session's PATH so whatever the system has, or lacks, does not matter.
 *
 * Prior art: GitHub Desktop ships the same portable git (`desktop/dugite-native`
 * on macOS and Linux, MinGit inside it on Windows) and points
 * `GIT_EXEC_PATH`/`GIT_TEMPLATE_DIR` at it (`dugite/lib/git-environment.ts`);
 * the Claude Agent SDK and OpenCode's desktop both carry their own runtime
 * rather than trust the machine's. The values here are that idea, pinned.
 *
 * Every version is at least two weeks old when it was pinned, and every hash
 * was read from the publisher: nodejs.org `SHASUMS256.txt`, the gh release's
 * `checksums.txt`, the git-for-windows release notes, GitHub's asset digest for
 * dugite-native, Enigma's `SHA256SUMS`, and the npm registry's `dist.integrity`.
 * A pin is moved by changing it here; the desktop app's own update carries it.
 *
 * Pure: no download or filesystem access, so the resolver, the checksum check
 * and the PATH build are asserted without the network.
 */

/** The Enigma release the toolchain installs. Kept equal to `ENIGMA_VERSION`
 *  (`enigma.ts`) by a test, so a bump there fails until its hash is pinned here;
 *  this module imports nothing so the desktop app can bundle it alone. */
export const TOOLCHAIN_ENIGMA_VERSION = "1.73.0";

export const TOOLCHAIN_PLATFORMS = ["win32", "darwin", "linux"] as const;
export type ToolchainPlatform = (typeof TOOLCHAIN_PLATFORMS)[number];
export const TOOLCHAIN_ARCHES = ["x64", "arm64"] as const;
export type ToolchainArch = (typeof TOOLCHAIN_ARCHES)[number];

/** The base tools every local session gets, in install order. */
export const TOOLCHAIN_BASE = ["git", "node", "gh", "enigma"] as const;
/** The agent CLIs Polaris can install for a person. The rest of the catalogue
 *  in `agent-clis.ts` still has to be on the machine already. */
export const TOOLCHAIN_AGENTS = ["claude", "codex", "opencode"] as const;
export type ToolchainTool = (typeof TOOLCHAIN_BASE)[number] | (typeof TOOLCHAIN_AGENTS)[number];

/** What the downloaded file is and how it becomes a directory. */
export type ToolchainArchive = "zip" | "tar.gz" | "npm";

/** One file to download for one tool on one platform. */
export interface ToolchainDownload {
    readonly tool: ToolchainTool;
    readonly version: string;
    readonly url: string;
    readonly archive: ToolchainArchive;
    /** Lowercase hex SHA-256, for archives. */
    readonly sha256?: string;
    /** npm `dist.integrity` (sha512, base64), for npm tarballs. */
    readonly integrity?: string;
    /** Directories, relative to the tool's install directory, that go on PATH. */
    readonly binDirs: readonly string[];
    /** The command the tool answers to, relative to its install directory. */
    readonly command: string;
}

const NODE_VERSION = "24.22.2";
const GH_VERSION = "2.103.3";
const MINGIT_TAG = "v2.56.0.windows.4";
const MINGIT_VERSION = "2.56.0.4";
const DUGITE_TAG = "v2.56.0-2";
const DUGITE_BUILD = "v2.56.0-a44aeca";

type Key = `${ToolchainPlatform}-${ToolchainArch}`;

const NODE: Record<Key, { file: string; sha256: string }> = {
    "win32-x64": { file: `node-v${NODE_VERSION}-win-x64.zip`, sha256: "ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2" },
    "win32-arm64": { file: `node-v${NODE_VERSION}-win-arm64.zip`, sha256: "f47968c213105077f64c6510f007632c0ca2574802a0b5067c327c49abe1c468" },
    "darwin-x64": { file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, sha256: "d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52" },
    "darwin-arm64": { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha256: "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a" },
    "linux-x64": { file: `node-v${NODE_VERSION}-linux-x64.tar.gz`, sha256: "361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9" },
    "linux-arm64": { file: `node-v${NODE_VERSION}-linux-arm64.tar.gz`, sha256: "95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2" }
};

const GH: Record<Key, { file: string; sha256: string }> = {
    "win32-x64": { file: `gh_${GH_VERSION}_windows_amd64.zip`, sha256: "98d0cfa794721665d7973dd728c78aff7bd836d58f10f6d7a03568eccb0a22e0" },
    "win32-arm64": { file: `gh_${GH_VERSION}_windows_arm64.zip`, sha256: "197211c98687d7770ac331fe8a3b6c198c389108c1536cdbedf659fe4703e484" },
    "darwin-x64": { file: `gh_${GH_VERSION}_macOS_amd64.zip`, sha256: "a2f86418f4350ae6e9ec60d5000bdf7665728436946a97fc27fe50e6ae752682" },
    "darwin-arm64": { file: `gh_${GH_VERSION}_macOS_arm64.zip`, sha256: "d700207eae9ae98fe2b89535c2c087c07823d4628c56364695a5a07ef311c062" },
    "linux-x64": { file: `gh_${GH_VERSION}_linux_amd64.tar.gz`, sha256: "4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d" },
    "linux-arm64": { file: `gh_${GH_VERSION}_linux_arm64.tar.gz`, sha256: "ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63" }
};

const GIT: Record<Key, { file: string; sha256: string }> = {
    "win32-x64": { file: `MinGit-${MINGIT_VERSION}-64-bit.zip`, sha256: "e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877" },
    "win32-arm64": { file: `MinGit-${MINGIT_VERSION}-arm64.zip`, sha256: "70f7649f78088c1db1d2f3571ca46a04d5bef06e4e9d56d8ed7f9829e8c6c4db" },
    "darwin-x64": { file: `dugite-native-${DUGITE_BUILD}-macOS-x64.tar.gz`, sha256: "52cc663281e1ec2f1d76ba781193ca4847e62dbbf767f6c99ec9ec5b978a7659" },
    "darwin-arm64": { file: `dugite-native-${DUGITE_BUILD}-macOS-arm64.tar.gz`, sha256: "1110de343de11cc6f469b782b60f36217b9199b5e06875dd65baa26dd60563c7" },
    "linux-x64": { file: `dugite-native-${DUGITE_BUILD}-ubuntu-x64.tar.gz`, sha256: "1efd8ce0516b670b6b6d0f49ecaf395ceb8cf7fff3f5857259763d97a1238df9" },
    "linux-arm64": { file: `dugite-native-${DUGITE_BUILD}-ubuntu-arm64.tar.gz`, sha256: "d5ce120515bf3013a014e6a918aa87ec0f7a6f5f9687c48d50127e637cb9b6c2" }
};

/** Enigma's cross-platform package (`enigma-cli-<v>.tgz` in its release), run
 *  by the managed Node, the launcher `scripts/install.sh` prefers when Node is
 *  there - so one file serves every platform, arm64 Windows and Intel macs
 *  included, which have no standalone binary. Pinned to `TOOLCHAIN_ENIGMA_VERSION`. */
const ENIGMA_PACKAGE: Record<string, string> = {
    "1.73.0": "77ffd4bdfda126b333bdcec1c242150e06d79dd6bd891074a1890b3eccc08971"
};

/** The agent CLIs, from the npm registry. Each one is installed by the managed
 *  npm from the tarball checked here, so its own dependencies (the per-platform
 *  binary) are resolved and integrity-checked by npm against the registry. */
export const TOOLCHAIN_AGENT_PACKAGES: Record<(typeof TOOLCHAIN_AGENTS)[number], { name: string; version: string; integrity: string; bin: string }> = {
    claude: {
        name: "@anthropic-ai/claude-code",
        version: "2.1.316",
        integrity: "sha512-i3BpzyDkcCPnsa0CSkWgxGPs7WMsyqDkxkqT0SDxyEC5XMIxEmcUmluWRHG9VSeBY8Vyv+l9X34JvJ/Bj54nBQ==",
        bin: "claude"
    },
    codex: {
        name: "@openai/codex",
        version: "0.166.0",
        integrity: "sha512-2Szlp1l1cz5TX1ccpX4Zok3DZrot9xeZe0km+6/1v8JmqxADwyJxKBJah4dBymkwtS25j/u6dipJusTOI97Z8Q==",
        bin: "codex"
    },
    opencode: {
        name: "opencode-ai",
        version: "1.19.5",
        integrity: "sha512-tEqMvQahfhdDj8vceYpXtoIrvjPXm5XRfetWnPN5YISueU7adNx9JcUA3zZ+2GKuDVgDpGdQe1ZLtCZDjqodvA==",
        bin: "opencode"
    }
};

/** The Claude Agent SDK, which the "Claude (your subscription)" chat path runs
 *  on the person's computer. Installed beside Claude Code, same release train. */
export const TOOLCHAIN_CLAUDE_AGENT_SDK = {
    name: "@anthropic-ai/claude-agent-sdk",
    version: "0.3.316",
    integrity: "sha512-mCMr0que5kIy80JslJub6WFDB2+GYRGWNeVgSZaBpkBwXrr4wnRMnnGHitkA2BEJ5QP5xWyc6YH/6do/edxCWg=="
} as const;

/** The npm registry's tarball address for a package version. */
export function npmTarballUrl(name: string, version: string): string {
    const base = name.includes("/") ? name.split("/")[1] : name;
    return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

export function isToolchainPlatform(value: string): value is ToolchainPlatform {
    return (TOOLCHAIN_PLATFORMS as readonly string[]).includes(value);
}

export function isToolchainArch(value: string): value is ToolchainArch {
    return (TOOLCHAIN_ARCHES as readonly string[]).includes(value);
}

export function isToolchainAgent(value: string): value is (typeof TOOLCHAIN_AGENTS)[number] {
    return (TOOLCHAIN_AGENTS as readonly string[]).includes(value);
}

/**
 * The download for one tool on one machine, or null when Polaris has none for
 * it (an unsupported machine, or an Enigma version with no pinned hash).
 */
export function resolveToolchainDownload(tool: ToolchainTool, platform: string, arch: string): ToolchainDownload | null {
    if (!isToolchainPlatform(platform) || !isToolchainArch(arch)) return null;
    const key: Key = `${platform}-${arch}`;
    const win = platform === "win32";
    switch (tool) {
        case "node": {
            const pin = NODE[key];
            return {
                tool,
                version: NODE_VERSION,
                url: `https://nodejs.org/dist/v${NODE_VERSION}/${pin.file}`,
                archive: win ? "zip" : "tar.gz",
                sha256: pin.sha256,
                binDirs: win ? ["."] : ["bin"],
                command: win ? "node.exe" : "bin/node"
            };
        }
        case "gh": {
            const pin = GH[key];
            return {
                tool,
                version: GH_VERSION,
                url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${pin.file}`,
                archive: platform === "linux" ? "tar.gz" : "zip",
                sha256: pin.sha256,
                binDirs: ["bin"],
                command: win ? "bin/gh.exe" : "bin/gh"
            };
        }
        case "git": {
            const pin = GIT[key];
            return {
                tool,
                version: win ? MINGIT_VERSION : DUGITE_TAG.slice(1),
                url: win
                    ? `https://github.com/git-for-windows/git/releases/download/${MINGIT_TAG}/${pin.file}`
                    : `https://github.com/desktop/dugite-native/releases/download/${DUGITE_TAG}/${pin.file}`,
                archive: win ? "zip" : "tar.gz",
                sha256: pin.sha256,
                // MinGit's `cmd\git.exe` sets up its own environment; that is
                // the one directory its documentation puts on PATH.
                binDirs: win ? ["cmd"] : ["bin"],
                command: win ? "cmd/git.exe" : "bin/git"
            };
        }
        case "enigma": {
            const sha256 = ENIGMA_PACKAGE[TOOLCHAIN_ENIGMA_VERSION];
            if (!sha256) return null;
            return {
                tool,
                version: TOOLCHAIN_ENIGMA_VERSION,
                url: `https://github.com/FJRG2007/enigma/releases/download/v${TOOLCHAIN_ENIGMA_VERSION}/enigma-cli-${TOOLCHAIN_ENIGMA_VERSION}.tgz`,
                archive: "tar.gz",
                sha256,
                // The launcher the installer writes beside the package.
                binDirs: ["bin"],
                command: win ? "bin/enigma.cmd" : "bin/enigma"
            };
        }
        default: {
            const pkg = TOOLCHAIN_AGENT_PACKAGES[tool];
            return {
                tool,
                version: pkg.version,
                url: npmTarballUrl(pkg.name, pkg.version),
                archive: "npm",
                integrity: pkg.integrity,
                // npm's `--prefix` puts shims in the prefix root on Windows and
                // in `bin` elsewhere.
                binDirs: win ? ["."] : ["bin"],
                command: win ? `${pkg.bin}.cmd` : `bin/${pkg.bin}`
            };
        }
    }
}

/** Every download a session with these agents needs, base tools first. A tool
 *  with no download for this machine is left out; the caller reports it. */
export function resolveToolchain(platform: string, arch: string, agents: readonly string[]): ToolchainDownload[] {
    const wanted: ToolchainTool[] = [...TOOLCHAIN_BASE, ...TOOLCHAIN_AGENTS.filter((id) => agents.includes(id))];
    return wanted.map((tool) => resolveToolchainDownload(tool, platform, arch)).filter((item): item is ToolchainDownload => item !== null);
}

/** Where a tool lives under the toolchain root. The version is part of the
 *  path, so an update installs beside the old one and switches atomically. */
export function toolchainToolDir(root: string, platform: string, download: Pick<ToolchainDownload, "tool" | "version">): string {
    return joinPath(platform, root, download.tool, download.version);
}

/** Whether `actual` (hex, any case) is the pinned SHA-256. Constant-length
 *  compare; a missing or malformed pin never matches. */
export function sha256Matches(actual: string, expected: string | undefined): boolean {
    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) return false;
    return actual.toLowerCase() === expected;
}

/** The base64 digest an npm `sha512-...` integrity names, or null. */
export function sriSha512(integrity: string | undefined): string | null {
    const match = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(integrity ?? "");
    return match?.[1] ?? null;
}

/** Whether `actualBase64` (a SHA-512 digest) is the one `integrity` names. */
export function integrityMatches(actualBase64: string, integrity: string | undefined): boolean {
    const expected = sriSha512(integrity);
    return expected !== null && expected === actualBase64;
}

function joinPath(platform: string, ...parts: string[]): string {
    const sep = platform === "win32" ? "\\" : "/";
    return parts
        .map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, "") : part.replace(/^[\\/]+|[\\/]+$/g, "")))
        .filter((part) => part !== "" && part !== ".")
        .join(sep)
        .replace(/[\\/]/g, sep);
}

/** The directories the toolchain puts on PATH, in order. */
export function toolchainBinDirs(root: string, platform: string, downloads: readonly ToolchainDownload[]): string[] {
    return downloads.flatMap((download) => download.binDirs.map((dir) => joinPath(platform, toolchainToolDir(root, platform, download), dir)));
}

/**
 * The environment a local session runs with: the toolchain first on PATH, the
 * portable git told where its pieces are, and npm's global prefix pointed into
 * the toolchain so an agent that installs something never needs admin rights.
 *
 * `base` is the session's environment so far. The PATH key keeps the casing it
 * had (Windows calls it `Path`), and a duplicate key of another casing is
 * dropped, since a child sees only one.
 */
export function toolchainEnv(
    root: string,
    platform: string,
    downloads: readonly ToolchainDownload[],
    base: Record<string, string | undefined>
): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
    const win = platform === "win32";
    const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
    const pathKey = pathKeys[0] ?? (win ? "Path" : "PATH");
    const existing = pathKeys.map((key) => env[key]).find((value) => value) ?? "";
    for (const key of pathKeys) delete env[key];
    const delimiter = win ? ";" : ":";
    const npmGlobal = joinPath(platform, root, "npm-global");
    const ours = [...toolchainBinDirs(root, platform, downloads), win ? npmGlobal : `${npmGlobal}/bin`];
    const rest = existing.split(delimiter).filter((dir) => dir !== "" && !ours.includes(dir));
    env[pathKey] = [...ours, ...rest].join(delimiter);

    const git = downloads.find((download) => download.tool === "git");
    if (git && !win) {
        // What `dugite` sets for the same build (`lib/git-environment.ts`).
        const gitDir = toolchainToolDir(root, platform, git);
        env.GIT_EXEC_PATH = `${gitDir}/libexec/git-core`;
        env.GIT_TEMPLATE_DIR = `${gitDir}/share/git-core/templates`;
        if (!env.GIT_CONFIG_SYSTEM) env.GIT_CONFIG_SYSTEM = `${gitDir}/etc/gitconfig`;
        if (platform === "linux" && !env.GIT_SSL_CAINFO) env.GIT_SSL_CAINFO = `${gitDir}/ssl/cacert.pem`;
    }
    env.NPM_CONFIG_PREFIX = npmGlobal;
    env.POLARIS_TOOLCHAIN = root;
    return env;
}
