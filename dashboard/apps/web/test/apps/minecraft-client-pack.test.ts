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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import {
    PACK_RECORD,
    SET_ASIDE,
    asideTable,
    packTable,
    powershellInstaller,
    scriptName,
    scriptUrl,
    shellInstaller
} from "@polaris-app/game-servers/src/lib/minecraft/pack-scripts";

/**
 * A name typed by an operator, written the way somebody would to get a command
 * onto every player's machine. It is used for every generated script here, so
 * anything that would end the comment it sits in ends the tests too.
 */
const HOSTILE = 'Offgrid\nrm -rf "$HOME/.minecraft"\n#';

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
const POWERSHELL = ["pwsh", "powershell"].find((shell) =>
    has(shell, ["-NoProfile", "-Command", "exit 0"])
);

describe("the mod list both installers read", () => {
    it("is one tab-separated line per mod", () => {
        expect(packTable([{ filename: "a.jar", sha1: "abc", url: "https://x/a.jar" }])).toBe(
            "a.jar\tabc\thttps://x/a.jar\n"
        );
    });

    it("carries what could not be resolved, on one line and without its own tabs", () => {
        expect(packTable([], ["xaeros-minimap", "sodium\tand\nmore"])).toBe(
            "!\txaeros-minimap\n!\tsodium and more\n"
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
 * What the operator types and what the player's request carried both end up
 * inside a script that is piped into an interpreter on somebody else's machine.
 * Neither may be able to end the line it is written on.
 */
describe("what a script may carry of somebody else's text", () => {
    it("keeps a name to one line, and to what a name is made of", () => {
        expect(scriptName(HOSTILE)).toBe("Offgrid rm -rf HOME .minecraft");
        expect(scriptName("Ñandú survival")).toBe("Ñandú survival");
        expect(scriptName("\n\n")).toBe("this server");
        expect(scriptName("x".repeat(80))).toHaveLength(48);
    });

    it("leaves every line of both scripts a comment or the code that was meant", () => {
        const url = "https://polaris.test/pack.tsv";
        for (const build of [shellInstaller, powershellInstaller]) {
            const script = build(url, HOSTILE);
            // The name cannot add a line, so the script is the one a plain name
            // makes, with a longer comment on it.
            expect(script.split("\n")).toHaveLength(build(url, "Offgrid").split("\n").length);
            expect(script).not.toContain('rm -rf "$HOME');
            expect(script.split("\n").filter((line) => line.includes("Offgrid"))).toEqual([
                script.split("\n")[build === shellInstaller ? 1 : 0]
            ]);
            const header = script.split("\n").slice(0, build === shellInstaller ? 3 : 2);
            expect(header.every((line) => line.startsWith("#"))).toBe(true);
        }
    });

    it("encodes an address that could otherwise run a command", () => {
        expect(scriptUrl("https://polaris.test/api/minecraft/pack/a-b/tok_en/pack.tsv")).toBe(
            "https://polaris.test/api/minecraft/pack/a-b/tok_en/pack.tsv"
        );
        expect(scriptUrl('https://a$(id)"x.test/pack.tsv')).toBe(
            "https://a%24(id)%22x.test/pack.tsv"
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
    let missing: string[] = [];
    /** What Polaris says about a player's own jars, by what is in them. */
    let aside: Record<string, string> = {};

    beforeAll(async () => {
        server = createServer((request, response) => {
            const name = (request.url ?? "").replace(/^\/+/, "");
            if (name === "foreign.tsv" && request.method === "POST") {
                let body = "";
                request.on("data", (chunk: Buffer) => (body += chunk.toString()));
                request.on("end", () => {
                    const moves = body
                        .split("\n")
                        .map((line) => line.replace(/\r$/, "").split("\t"))
                        .filter(([sum]) => sum && aside[sum])
                        .map(([sum, jar]) => ({ name: jar ?? "", reason: aside[sum ?? ""] ?? "" }));
                    response.writeHead(200, { "content-type": "text/plain" });
                    response.end(asideTable(moves));
                });
                return;
            }
            if (name === "pack.tsv") {
                const body = packTable(
                    list.map((jar) => ({
                        filename: jar,
                        sha1: sha1(JARS[jar] ?? ""),
                        url: `${origin}/${jar}`
                    })),
                    missing
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
    async function run(
        kind: "sh" | "ps1",
        dir: string
    ): Promise<{ code: number | null; output: string }> {
        const manifest = `${origin}/pack.tsv`;
        const script = join(
            mkdtempSync(join(tmpdir(), "polaris-pack-script-")),
            kind === "sh" ? "install.sh" : "install.ps1"
        );
        writeFileSync(
            script,
            kind === "sh"
                ? shellInstaller(manifest, HOSTILE)
                : powershellInstaller(manifest, HOSTILE),
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
        missing = [];
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

    /**
     * The runs that must not cost the player a jar.
     *
     * A list that came back empty and a list that came back short are the two
     * shapes a Modrinth outage takes, and on either of them the folder has to be
     * exactly as it was: a mod taken away here is a friend who cannot join, and
     * the reason is on a server neither of them can see.
     */
    async function refuses(kind: "sh" | "ps1"): Promise<void> {
        const dir = mkdtempSync(join(tmpdir(), "polaris-mods-"));
        missing = [];
        try {
            list = ["alpha-1.0.jar", "beta-2.0.jar"];
            expect((await run(kind, dir)).code).toBe(0);

            // One entry the server could not resolve: the jar it stands for is
            // still needed, so nothing is taken away and the player is told.
            list = ["alpha-1.0.jar"];
            missing = ["beta"];
            const partial = await run(kind, dir);
            expect(partial.code, partial.output).toBe(0);
            expect(partial.output).toContain("no build could be worked out for beta");
            expect(partial.output).toContain("nothing was taken away");
            expect(readdirSync(dir).sort()).toEqual(
                [PACK_RECORD, "alpha-1.0.jar", "beta-2.0.jar"].sort()
            );

            // Nothing at all: a failure rather than a server that dropped
            // everything, and it ends before the folder is touched.
            list = [];
            missing = [];
            const empty = await run(kind, dir);
            expect(empty.code, empty.output).not.toBe(0);
            expect(empty.output).toContain("the mod list came back empty");
            expect(readdirSync(dir).sort()).toEqual(
                [PACK_RECORD, "alpha-1.0.jar", "beta-2.0.jar"].sort()
            );

            // And the record still knows the unresolved jar is this pack's, so
            // the run where the server really does drop it takes it away.
            list = ["alpha-1.0.jar"];
            const dropped = await run(kind, dir);
            expect(dropped.code, dropped.output).toBe(0);
            expect(readdirSync(dir).sort()).toEqual([PACK_RECORD, "alpha-1.0.jar"].sort());
        } finally {
            missing = [];
            rmSync(dir, { recursive: true, force: true });
        }
    }

    /**
     * A player who installed mods by hand before ever running this: another
     * version of one in the pack, under its own name, and something of theirs the
     * pack has nothing to do with. The first stops the game from starting next to
     * the pack's copy, so it is moved out of the folder - not deleted - and the
     * second is left exactly where it was.
     */
    async function setsAside(kind: "sh" | "ps1"): Promise<void> {
        const root = mkdtempSync(join(tmpdir(), "polaris-minecraft-"));
        const dir = join(root, "mods");
        mkdirSync(dir);
        missing = [];
        try {
            writeFileSync(join(dir, "alpha-0.9-by-hand.jar"), "old alpha", "utf8");
            writeFileSync(join(dir, "their-own-minimap.jar"), "not ours", "utf8");
            aside = { [sha1("old alpha")]: "another copy of alpha, installed as alpha-1.0.jar" };
            list = ["alpha-1.0.jar"];

            const run1 = await run(kind, dir);
            expect(run1.code, run1.output).toBe(0);
            expect(run1.output).toContain("moved alpha-0.9-by-hand.jar");
            expect(run1.output).toContain("1 moved aside");
            expect(readdirSync(dir).sort()).toEqual(
                [PACK_RECORD, "alpha-1.0.jar", "their-own-minimap.jar"].sort()
            );
            expect(readFileSync(join(root, SET_ASIDE, "alpha-0.9-by-hand.jar"), "utf8")).toBe(
                "old alpha"
            );

            // Nothing left to move the next time round.
            const run2 = await run(kind, dir);
            expect(run2.code, run2.output).toBe(0);
            expect(run2.output).toContain("0 moved aside");
        } finally {
            aside = {};
            rmSync(root, { recursive: true, force: true });
        }
    }

    it.runIf(HAS_SH)("move aside a hand-installed copy of a pack mod, from a shell", async () => {
        await setsAside("sh");
    });

    it.runIf(POWERSHELL)(
        "move aside a hand-installed copy of a pack mod, from PowerShell",
        async () => {
            await setsAside("ps1");
        }
    );

    it.runIf(HAS_SH)("install, keep and update a mods folder, from a shell", async () => {
        await exercise("sh");
    });

    it.runIf(POWERSHELL)("install, keep and update a mods folder, from PowerShell", async () => {
        await exercise("ps1");
    });

    it.runIf(HAS_SH)("take nothing away on a partial or empty list, from a shell", async () => {
        await refuses("sh");
    });

    it.runIf(POWERSHELL)(
        "take nothing away on a partial or empty list, from PowerShell",
        async () => {
            await refuses("ps1");
        }
    );
});
