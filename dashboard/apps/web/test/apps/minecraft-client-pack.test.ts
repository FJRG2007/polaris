/**
 * The pack a player installs, and the two scripts that install it.
 *
 * The scripts are the part that has to be exercised rather than read: they run on
 * somebody else's laptop, once, and a mistake in them is a friend who cannot join
 * and a mods folder that may have lost a jar. So both are run here against a real
 * folder and a real server serving a real list - what they install, what they
 * leave alone and what they take away are assertions, not intentions.
 *
 * Each runs only where its interpreter exists: the shell one everywhere a POSIX
 * shell and curl are, the PowerShell one on a machine that has PowerShell. What
 * did not run is skipped rather than quietly passing.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import {
    PACK_RECORD,
    packTable,
    powershellInstaller,
    shellInstaller
} from "@/lib/apps/minecraft/pack-scripts";

/** A jar is only ever bytes to these scripts, so the fixtures are bytes. */
const JARS: Record<string, string> = {
    "alpha-1.0.jar": "alpha contents",
    "beta-2.0.jar": "beta contents"
};

const sha1 = (body: string): string => createHash("sha1").update(body).digest("hex");

function has(command: string, args: string[]): boolean {
    try {
        execFileSync(command, args, { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

const HAS_SH = has("sh", ["-c", "command -v curl"]);
const POWERSHELL = ["pwsh", "powershell"].find((shell) => has(shell, ["-NoProfile", "-Command", "exit 0"]));

describe("the mod list both installers read", () => {
    it("is one tab-separated line per mod", () => {
        expect(packTable([{ filename: "a.jar", sha1: "abc", url: "https://x/a.jar" }])).toBe(
            "a.jar\tabc\thttps://x/a.jar\n"
        );
    });

    it("says in both scripts which server it is for", () => {
        expect(shellInstaller("https://polaris.test/pack.tsv", "Offgrid")).toContain('"Offgrid"');
        expect(powershellInstaller("https://polaris.test/pack.tsv", "Offgrid")).toContain(
            '"Offgrid"'
        );
    });
});

/**
 * A stand-in for Polaris and Modrinth at once: it serves the list and the files.
 *
 * `list` is what the next request gets, so a test can change what the server
 * carries between two runs of the installer - which is the whole of what
 * "run it again to update" has to get right.
 */
describe.runIf(HAS_SH || POWERSHELL)("the installers", () => {
    let server: Server;
    let origin = "";
    let list: string[] = [];

    beforeAll(async () => {
        server = createServer((request, response) => {
            const name = (request.url ?? "").replace(/^\/+/, "");
            if (name === "pack.tsv") {
                const body = packTable(
                    list.map((jar) => ({
                        filename: jar,
                        sha1: sha1(JARS[jar] ?? ""),
                        url: `${origin}/${jar}`
                    }))
                );
                response.writeHead(200, { "content-type": "text/plain" });
                response.end(body);
                return;
            }
            const jar = JARS[name];
            if (!jar) {
                response.writeHead(404);
                response.end("no");
                return;
            }
            response.writeHead(200, { "content-type": "application/java-archive" });
            response.end(jar);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    /**
     * One run of an installer against its own throwaway mods folder.
     *
     * Spawned rather than run synchronously, because the list and the files it
     * downloads are served by this same process: a synchronous child would block
     * the loop that has to answer it, and the two would wait for each other for
     * ever.
     */
    async function run(kind: "sh" | "ps1", dir: string): Promise<{ code: number | null; output: string }> {
        const manifest = `${origin}/pack.tsv`;
        const script = join(
            mkdtempSync(join(tmpdir(), "polaris-pack-script-")),
            kind === "sh" ? "install.sh" : "install.ps1"
        );
        writeFileSync(
            script,
            kind === "sh"
                ? shellInstaller(manifest, "Offgrid")
                : powershellInstaller(manifest, "Offgrid"),
            "utf8"
        );
        const [command, args] =
            kind === "sh"
                ? ["sh", [script]]
                : [
                      POWERSHELL ?? "powershell",
                      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]
                  ];
        return await new Promise((resolve) => {
            const child = spawn(command as string, args as string[], {
                env: { ...process.env, POLARIS_MC_DIR: dir }
            });
            let output = "";
            child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
            child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
            child.on("close", (code) => resolve({ code, output }));
        });
    }

    /** The same three assertions for either script: install, leave alone, update. */
    async function exercise(kind: "sh" | "ps1"): Promise<void> {
        const dir = mkdtempSync(join(tmpdir(), "polaris-mods-"));
        try {
            // Something of the player's own, which nothing here may touch.
            writeFileSync(join(dir, "their-own-minimap.jar"), "not ours", "utf8");

            list = ["alpha-1.0.jar", "beta-2.0.jar"];
            const first = await run(kind, dir);
            expect(first.code, first.output).toBe(0);
            expect(readdirSync(dir).sort()).toEqual(
                [PACK_RECORD, "alpha-1.0.jar", "beta-2.0.jar", "their-own-minimap.jar"].sort()
            );
            expect(readFileSync(join(dir, "alpha-1.0.jar"), "utf8")).toBe(JARS["alpha-1.0.jar"]);

            // Run again with nothing changed: it downloads none of it.
            const again = await run(kind, dir);
            expect(again.code, again.output).toBe(0);
            expect(again.output).toContain("0 installed");
            expect(again.output).toContain("2 already current");

            // The server drops one and the player runs the same line: the jar the
            // pack installed goes, their own stays.
            list = ["alpha-1.0.jar"];
            const third = await run(kind, dir);
            expect(third.code, third.output).toBe(0);
            expect(readdirSync(dir).sort()).toEqual(
                [PACK_RECORD, "alpha-1.0.jar", "their-own-minimap.jar"].sort()
            );
            expect(readFileSync(join(dir, "their-own-minimap.jar"), "utf8")).toBe("not ours");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    it.runIf(HAS_SH)("install, keep and update a mods folder, from a shell", async () => {
        await exercise("sh");
    });

    it.runIf(POWERSHELL)(
        "install, keep and update a mods folder, from PowerShell",
        async () => {
            await exercise("ps1");
        }
    );
});
