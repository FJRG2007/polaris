import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { claudeHookSettings, hookScript } from "@/lib/agents/session-hooks";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import {
    MEMORY_FILE_MAX_BYTES,
    MEMORY_TOTAL_MAX_BYTES,
    memoryKey,
    memorySyncScript,
    parseMemoryUpload,
    readStoredFiles,
    repoCheckoutDir,
    repoMemoryDir,
    restoreBody
} from "@/lib/agents/session-memory";

/** Whether a POSIX shell is on hand (Git Bash on Windows counts). */
function hasSh(): boolean {
    try {
        execFileSync("sh", ["-c", "command -v base64 && command -v cksum"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("path namespacing", () => {
    it("keys a repository as owner__name, lowercased", () => {
        expect(memoryKey("Acme/Web.App")).toBe("acme__web.app");
        expect(repoCheckoutDir("Acme/Web.App")).toBe("/session/repos/acme__web.app");
        expect(repoMemoryDir("acme/web.app")).toBe("/home/node/.polaris/memory/acme__web.app");
    });

    it("refuses what is not owner/name", () => {
        for (const bad of ["", "acme", "a/b/c", "acme/..", "acme/.", "/web", "acme/", "ac_me/web"]) {
            expect(memoryKey(bad), bad).toBeNull();
        }
        expect(() => repoCheckoutDir("acme")).toThrow();
    });

    it("never gives two repositories the same memory dir or checkout", () => {
        const repos = ["acme/web", "acme/api", "other/web", "acme-web/x", "acme/web-x", "a/cme__web"];
        const keys = repos.map(memoryKey).filter((key): key is string => key !== null);
        // `a/cme__web` cannot collide with `acme/web`: an owner has no `_`.
        expect(new Set(keys.map((key) => key.toLowerCase())).size).toBe(keys.length);
        const dirs = keys.map((_, i) => repoMemoryDir(repos[i]));
        expect(new Set(dirs).size).toBe(dirs.length);
        expect(new Set(repos.map((repo) => repoCheckoutDir(repo))).size).toBe(repos.length);
        // One repository is one dir however it is spelled.
        expect(repoMemoryDir("ACME/Web")).toBe(repoMemoryDir("acme/web"));
    });
});

describe("upload validation", () => {
    it("accepts memory files and handoff pages", () => {
        const files = parseMemoryUpload({
            files: [
                { path: "memory/MEMORY.md", data: b64("# notes\n") },
                { path: "memory/topics/auth-flow.md", data: b64("x") },
                { path: "handoff/0123456789ab.md", data: b64("page") },
                { path: "handoff/0123456789ab.json", data: b64("{}") }
            ]
        });
        expect(files?.map((file) => file.path)).toHaveLength(4);
    });

    it("refuses traversal, absolute paths and anything outside the allowed dirs", () => {
        for (const path of [
            "memory/../../.ssh/authorized_keys",
            "memory/../x",
            "../memory/x",
            "/home/node/.bashrc",
            "memory/.hidden",
            "memory/a/b/c/d/e.md",
            "memory/",
            "handoff/../x.md",
            "handoff/notes.md",
            "handoff/0123456789ab.sh",
            ".claude/settings.json",
            "memory\\..\\x"
        ]) {
            expect(parseMemoryUpload({ files: [{ path, data: b64("x") }] }), path).toBeNull();
        }
    });

    it("refuses oversized files and an oversized total", () => {
        const big = "A".repeat(Math.ceil((MEMORY_FILE_MAX_BYTES + 3) / 3) * 4);
        expect(parseMemoryUpload({ files: [{ path: "memory/big.md", data: big }] })).toBeNull();
        const near = Buffer.alloc(MEMORY_FILE_MAX_BYTES - 1, 97).toString("base64");
        const count = Math.ceil(MEMORY_TOTAL_MAX_BYTES / (MEMORY_FILE_MAX_BYTES - 1)) + 1;
        const files = Array.from({ length: count }, (_, i) => ({ path: `memory/f${i}.md`, data: near }));
        expect(parseMemoryUpload({ files })).toBeNull();
        expect(parseMemoryUpload({ files: files.slice(0, 7) })).not.toBeNull();
    });

    it("refuses bad base64, duplicates and extra keys", () => {
        expect(parseMemoryUpload({ files: [{ path: "memory/a.md", data: "not base64!" }] })).toBeNull();
        expect(
            parseMemoryUpload({
                files: [
                    { path: "memory/a.md", data: b64("1") },
                    { path: "memory/a.md", data: b64("2") }
                ]
            })
        ).toBeNull();
        expect(parseMemoryUpload({ files: [], owner: "someone-else" })).toBeNull();
        expect(parseMemoryUpload(null)).toBeNull();
    });

    it("reads a stored row total, dropping what no longer passes", () => {
        expect(readStoredFiles(null)).toEqual([]);
        expect(
            readStoredFiles([{ path: "memory/a.md", data: b64("a") }, { path: "../x", data: "" }, 3])
        ).toEqual([{ path: "memory/a.md", data: b64("a") }]);
    });
});

describe("restore script", () => {
    const script = memorySyncScript({
        url: "https://polaris.example/api/agents/sessions/s1/memory",
        token: "tok'en",
        workdir: "/session/repos/acme__web",
        memoryDir: "/home/node/.polaris/memory/acme__web",
        handoffDir: "/home/node/.enigma/handoff"
    });

    it("bakes its paths in, quoted, and the token only as a header", () => {
        expect(script).toContain("mem='/home/node/.polaris/memory/acme__web'");
        expect(script).toContain("root='/session/repos/acme__web'");
        expect(script).toContain("auth='Authorization: Bearer tok'\\''en'");
        expect(script).not.toMatch(/\?token=/);
    });

    it("uploads nothing until a restore succeeded in this session", () => {
        const restoreEnd = script.indexOf(': > "$state/memory-restored"');
        const guard = script.indexOf('[ -f "$state/memory-restored" ] || exit 0');
        const upload = script.indexOf("-X POST");
        expect(restoreEnd).toBeGreaterThan(0);
        expect(guard).toBeGreaterThan(restoreEnd);
        expect(upload).toBeGreaterThan(guard);
        // A failed fetch exits before marking the restore done.
        const failed = script.indexOf("could not be fetched");
        expect(failed).toBeGreaterThan(0);
        expect(failed).toBeLessThan(restoreEnd);
    });

    it("checks every path again before writing it", () => {
        expect(script).toContain('case "$rel" in *..*|*[!A-Za-z0-9._/-]*) continue ;; esac');
        expect(script).toContain('handoff/?*) n="${rel#handoff/}"; case "$n" in */*) continue ;; esac');
    });

    it("serves stored files as a stamp and tab-separated lines", () => {
        const at = new Date(1_800_000_000_000);
        expect(restoreBody([{ path: "memory/a.md", data: "YQ==" }], at)).toBe(
            "updated=1800000000000\nmemory/a.md\tYQ==\n"
        );
        expect(restoreBody([], at)).toBe("updated=0\n");
    });

    it("is started by the hook at the end of a turn, and only when asked", () => {
        const withSync = hookScript("https://p/e", "t", undefined, { memorySync: true });
        expect(withSync).toContain('(sh "$(dirname "$0")/memory-sync.sh" >/dev/null 2>&1 &)');
        expect(withSync).toMatch(/\(Stop\|SessionEnd\)/);
        expect(hookScript("https://p/e", "t")).not.toContain("memory-sync");
    });

    it("points Claude Code at the repository's own memory dir", () => {
        expect(claudeHookSettings("/s/hook.sh", { memoryDir: "/home/node/.polaris/memory/acme__web" })).toMatchObject({
            autoMemoryDirectory: "/home/node/.polaris/memory/acme__web"
        });
        expect(claudeHookSettings("/s/hook.sh")).not.toHaveProperty("autoMemoryDirectory");
    });
});

describe.runIf(hasSh())("memory sync on a real shell", () => {
    /** A box: a state dir with the script, a home, and a curl that serves
     *  `served` on GET and keeps what a POST sent. */
    function box(served: string) {
        const dir = mkdtempSync(join(tmpdir(), "polaris-memory-")).replace(/\\/g, "/");
        const bin = `${dir}/bin`;
        mkdirSync(bin);
        mkdirSync(`${dir}/state`);
        writeFileSync(`${dir}/served.txt`, served);
        writeFileSync(
            `${bin}/curl`,
            [
                "#!/bin/sh",
                'out=""; data=""; post=""',
                'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; --data-binary) data="${2#@}"; shift ;; POST) post=1 ;; esac; shift; done',
                `if [ -n "$post" ]; then cp "$data" '${dir}/posted.json'; printf updated=42; exit 0; fi`,
                `cp '${dir}/served.txt' "$out"`,
                ""
            ].join("\n")
        );
        execFileSync("sh", ["-c", `chmod +x '${bin}/curl'`]);
        const paths = {
            url: "https://polaris.example/m",
            token: "t",
            workdir: "/session/repos/acme__web",
            memoryDir: `${dir}/home/.polaris/memory/acme__web`,
            handoffDir: `${dir}/home/.enigma/handoff`
        };
        writeFileSync(`${dir}/state/memory-sync.sh`, memorySyncScript(paths));
        const run = (...args: string[]) =>
            execFileSync("sh", [`${dir}/state/memory-sync.sh`, ...args], {
                env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
                encoding: "utf8"
            });
        return { dir, paths, run };
    }

    it("restores stored files, refuses a traversal line, and uploads them back", () => {
        const served = [
            "updated=7",
            `memory/MEMORY.md\t${b64("# remembered\n")}`,
            `memory/../../escape.md\t${b64("no")}`,
            `handoff/0123456789ab.json\t${b64('{\n  "root": "/session/repos/acme__web"\n}')}`,
            `handoff/0123456789ab.md\t${b64("page")}`,
            ""
        ].join("\n");
        const { dir, paths, run } = box(served);

        // No restore yet: nothing goes up.
        run();
        expect(existsSync(`${dir}/posted.json`)).toBe(false);

        run("restore");
        expect(readFileSync(`${paths.memoryDir}/MEMORY.md`, "utf8")).toBe("# remembered\n");
        expect(readFileSync(`${paths.handoffDir}/0123456789ab.md`, "utf8")).toBe("page");
        expect(existsSync(`${dir}/home/escape.md`)).toBe(false);
        expect(readFileSync(`${paths.memoryDir}.synced`, "utf8")).toBe("updated=7");

        writeFileSync(`${paths.memoryDir}/MEMORY.md`, "# remembered more\n");
        run();
        const posted = JSON.parse(readFileSync(`${dir}/posted.json`, "utf8"));
        const files = parseMemoryUpload(posted);
        expect(files?.map((file) => file.path).sort()).toEqual([
            "handoff/0123456789ab.json",
            "handoff/0123456789ab.md",
            "memory/MEMORY.md"
        ]);
        const memory = files?.find((file) => file.path === "memory/MEMORY.md");
        expect(Buffer.from(memory!.data, "base64").toString("utf8")).toBe("# remembered more\n");
        expect(readFileSync(`${paths.memoryDir}.synced`, "utf8")).toBe("updated=42");
    });

    it("leaves another repository's handoff alone", () => {
        const { dir, paths, run } = box("updated=0\n");
        mkdirSync(paths.handoffDir, { recursive: true });
        writeFileSync(`${paths.handoffDir}/aaaaaaaaaaaa.json`, '{\n  "root": "/session/repos/other__repo"\n}');
        writeFileSync(`${paths.handoffDir}/aaaaaaaaaaaa.md`, "theirs");
        run("restore");
        run();
        const files = parseMemoryUpload(JSON.parse(readFileSync(`${dir}/posted.json`, "utf8")));
        expect(files).toEqual([]);
        expect(readFileSync(`${paths.handoffDir}/aaaaaaaaaaaa.md`, "utf8")).toBe("theirs");
    });
});
