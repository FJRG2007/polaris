import * as toolchain from "./index.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ENIGMA_VERSION } from "../enigma.js";

const MACHINES = toolchain.TOOLCHAIN_PLATFORMS.flatMap((platform) => toolchain.TOOLCHAIN_ARCHES.map((arch) => [platform, arch] as const));

describe("resolveToolchain", () => {
    it.each(MACHINES)("has every base tool and agent on %s-%s, pinned and https", (platform, arch) => {
        const downloads = toolchain.resolveToolchain(platform, arch, ["claude", "codex", "opencode"]);
        expect(downloads.map((d) => d.tool)).toEqual(["git", "node", "gh", "enigma", "claude", "codex", "opencode"]);
        for (const d of downloads) {
            expect(d.url.startsWith("https://")).toBe(true);
            if (d.archive === "npm") expect(toolchain.sriSha512(d.integrity)).not.toBeNull();
            else expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    it("picks the archive each publisher ships for the machine", () => {
        const pick = (tool: toolchain.ToolchainTool, platform: string, arch: string) => toolchain.resolveToolchainDownload(tool, platform, arch)!;
        expect(pick("git", "win32", "x64").url).toBe("https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/MinGit-2.56.0.4-64-bit.zip");
        expect(pick("git", "win32", "x64").binDirs).toEqual(["cmd"]);
        expect(pick("git", "darwin", "arm64").url).toContain("dugite-native-v2.56.0-a44aeca-macOS-arm64.tar.gz");
        expect(pick("git", "linux", "x64").url).toContain("ubuntu-x64.tar.gz");
        expect(pick("node", "linux", "arm64").url).toBe("https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-arm64.tar.gz");
        expect(pick("node", "win32", "arm64").archive).toBe("zip");
        expect(pick("gh", "darwin", "x64").url).toContain("gh_2.103.3_macOS_amd64.zip");
        expect(pick("gh", "linux", "arm64").archive).toBe("tar.gz");
        expect(pick("claude", "linux", "x64").url).toBe("https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.316.tgz");
        expect(pick("opencode", "win32", "x64").command).toBe("opencode.cmd");
    });

    it("has nothing for a machine it cannot serve, and leaves out agents not asked for", () => {
        expect(toolchain.resolveToolchainDownload("node", "freebsd", "x64")).toBeNull();
        expect(toolchain.resolveToolchainDownload("node", "linux", "ia32")).toBeNull();
        expect(toolchain.resolveToolchain("freebsd", "x64", ["claude"])).toEqual([]);
        expect(toolchain.resolveToolchain("linux", "x64", ["gemini"]).map((d) => d.tool)).toEqual(["git", "node", "gh", "enigma"]);
    });

    it("installs the Enigma release sessions use, so a bump there needs a hash here", () => {
        expect(toolchain.TOOLCHAIN_ENIGMA_VERSION).toBe(ENIGMA_VERSION);
    });
});

describe("checksums", () => {
    const fixture = Buffer.from("polaris toolchain fixture\n");
    const sha256 = createHash("sha256").update(fixture).digest("hex");
    const sha512 = createHash("sha512").update(fixture).digest("base64");

    it("accepts the pinned SHA-256 in any case and refuses anything else", () => {
        expect(toolchain.sha256Matches(sha256, sha256)).toBe(true);
        expect(toolchain.sha256Matches(sha256.toUpperCase(), sha256)).toBe(true);
        expect(toolchain.sha256Matches(sha256, "0".repeat(64))).toBe(false);
        expect(toolchain.sha256Matches(sha256, undefined)).toBe(false);
        expect(toolchain.sha256Matches(sha256, sha256.toUpperCase())).toBe(false);
        expect(toolchain.sha256Matches("", "")).toBe(false);
    });

    it("reads npm integrity and compares the SHA-512", () => {
        expect(toolchain.integrityMatches(sha512, `sha512-${sha512}`)).toBe(true);
        expect(toolchain.integrityMatches(sha512, `sha1-${sha512}`)).toBe(false);
        expect(toolchain.integrityMatches(sha512, "sha512-abc")).toBe(false);
        expect(toolchain.integrityMatches(createHash("sha512").update("other").digest("base64"), `sha512-${sha512}`)).toBe(false);
    });
});

describe("toolchainEnv", () => {
    it("puts the toolchain first on a Windows Path and keeps its casing", () => {
        const root = "C:\\Users\\a\\AppData\\Roaming\\Polaris\\toolchain";
        const downloads = toolchain.resolveToolchain("win32", "x64", ["claude"]);
        const env = toolchain.toolchainEnv(root, "win32", downloads, {
            Path: "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd",
            PATH: "ignored",
            HOME: "C:\\Users\\a"
        });
        expect(Object.keys(env).filter((k) => k.toUpperCase() === "PATH")).toEqual(["Path"]);
        expect(env.Path.split(";").slice(0, 7)).toEqual([
            `${root}\\git\\2.56.0.4\\cmd`,
            `${root}\\node\\24.22.2`,
            `${root}\\gh\\2.103.3\\bin`,
            `${root}\\enigma\\1.73.0\\bin`,
            `${root}\\claude\\2.1.316`,
            `${root}\\npm-global`,
            "C:\\Windows\\system32"
        ]);
        expect(env.NPM_CONFIG_PREFIX).toBe(`${root}\\npm-global`);
        expect(env.GIT_EXEC_PATH).toBeUndefined();
        expect(env.HOME).toBe("C:\\Users\\a");
    });

    it("points the portable git at its own pieces on Linux, and works with no PATH at all", () => {
        const downloads = toolchain.resolveToolchain("linux", "arm64", []);
        const env = toolchain.toolchainEnv("/home/a/.config/Polaris/toolchain/", "linux", downloads, {});
        expect(env.PATH.split(":")[0]).toBe("/home/a/.config/Polaris/toolchain/git/2.56.0-2/bin");
        expect(env.PATH.split(":").at(-1)).toBe("/home/a/.config/Polaris/toolchain/npm-global/bin");
        expect(env.GIT_EXEC_PATH).toBe("/home/a/.config/Polaris/toolchain/git/2.56.0-2/libexec/git-core");
        expect(env.GIT_SSL_CAINFO).toBe("/home/a/.config/Polaris/toolchain/git/2.56.0-2/ssl/cacert.pem");
    });

    it("keeps a git system config the person set, and does not repeat a directory", () => {
        const downloads = toolchain.resolveToolchain("darwin", "x64", []);
        const root = "/Users/a/Library/Application Support/Polaris/toolchain";
        const ours = `${root}/node/24.22.2/bin`;
        const env = toolchain.toolchainEnv(root, "darwin", downloads, { PATH: `/usr/bin:${ours}`, GIT_CONFIG_SYSTEM: "/etc/mine" });
        expect(env.PATH.split(":").filter((d) => d === ours)).toHaveLength(1);
        expect(env.PATH.split(":").at(-1)).toBe("/usr/bin");
        expect(env.GIT_CONFIG_SYSTEM).toBe("/etc/mine");
        expect(env.GIT_SSL_CAINFO).toBeUndefined();
    });
});
