/**
 * `plr <noun> <verb>`: every name before that layout still reaches the same
 * command, says once on stderr what it is called now, and no two commands can
 * share a name.
 */

import { run } from "../../src/cli.js";
import { describe, expect, it } from "vitest";
import type { Probe } from "../../src/guard.js";
import { testContext } from "../helpers/context.js";
import { DEPRECATED, GROUPS, SHORTCUTS, helpText, resolve } from "../../src/commands.js";

const clean: Probe = { exists: () => false, read: () => null };

/** Where each name before `plr <noun> <verb>` has to land. */
const OLD_NAMES: Record<string, readonly string[]> = {
    login: ["auth", "login"],
    logout: ["auth", "logout"],
    whoami: ["auth", "whoami"],
    status: ["auth", "status"],
    profile: ["profile", "list"],
    profiles: ["profile", "list"],
    projects: ["project", "list"],
    service: ["service", "view"],
    deployments: ["deployment", "list"],
    deploy: ["service", "deploy"],
    redeploy: ["service", "deploy"],
    "build-log": ["deployment", "logs"],
    logs: ["service", "logs"],
    restart: ["service", "restart"],
    "env ls": ["env", "list"],
    "env set": ["env", "set"],
    "env rm": ["env", "remove"],
    open: ["dashboard", "open"],
    update: ["cli", "update"],
    uninstall: ["cli", "uninstall"]
};

describe("the command names", () => {
    it.each(Object.entries(OLD_NAMES))("%s still resolves", (old, [noun, verb]) => {
        const words = [...old.split(" "), ...(old === "service" ? ["shop/web"] : [])];
        const resolved = resolve(words);
        expect(resolved.kind).toBe("run");
        if (resolved.kind !== "run") return;
        expect([resolved.group.noun, resolved.command.verb]).toEqual([noun, verb]);
    });

    it("covers every deprecated name in that list", () => {
        for (const old of [...Object.keys(DEPRECATED), ...Object.keys(SHORTCUTS)])
            expect(OLD_NAMES).toHaveProperty([old]);
    });

    it("names the new command for a deprecated one, and not for a current one", () => {
        const old = resolve(["build-log", "dep_1"]);
        expect(old.kind === "run" && old.notice).toBe(
            'plr: "plr build-log" is now "plr deployment logs"; the old name keeps working.\n'
        );
        expect(old.kind === "run" && old.args).toEqual(["dep_1"]);
        for (const words of [["login"], ["deployment", "logs", "dep_1"], ["env", "ls", "x"]]) {
            const current = resolve(words);
            expect(current.kind === "run" && current.notice).toBeUndefined();
        }
    });

    it("reads plr service SERVICE the old way, and with POLARIS_SERVICE alone", () => {
        const typed = resolve(["service", "shop/web"]);
        expect(typed.kind === "run" && [typed.command.verb, typed.args]).toEqual([
            "view",
            ["shop/web"]
        ]);
        expect(resolve(["service"]).kind).toBe("help");
        const fromEnv = resolve(["service"], { POLARIS_SERVICE: "shop/web" });
        expect(fromEnv.kind === "run" && fromEnv.command.verb).toBe("view");
    });

    it("never gives two commands one name", () => {
        const nouns = GROUPS.map((group) => group.noun);
        const topLevel = [...nouns, ...Object.keys(DEPRECATED), ...Object.keys(SHORTCUTS)];
        expect(new Set(topLevel).size).toBe(topLevel.length);
        for (const group of GROUPS) {
            const verbs = group.commands.flatMap((command) => [
                command.verb,
                ...(command.aliases ?? [])
            ]);
            expect(new Set(verbs).size, group.noun).toBe(verbs.length);
        }
    });

    it("refuses a word that is no command, naming where the help is", () => {
        expect(resolve(["nope"])).toEqual({
            kind: "unknown",
            message: '"nope" is not a plr command.'
        });
        expect(resolve(["env", "nope"]).kind).toBe("unknown");
    });
});

describe("the help", () => {
    it("lists every group and every command, and hides the deprecated names", () => {
        const help = helpText();
        for (const group of GROUPS) {
            expect(help).toContain(`${group.title}\n`);
            for (const command of group.commands)
                expect(help).toContain(`plr ${group.noun} ${command.verb}`);
        }
        for (const old of Object.keys(DEPRECATED)) expect(help).not.toMatch(`plr ${old} `);
    });

    it("shows one group for plr NOUN, plr NOUN --help and an old name with --help", async () => {
        for (const argv of [["env"], ["env", "--help"], ["help", "env"], ["env", "set", "-h"]]) {
            const { context, stdout } = await testContext();
            await run(argv, context, clean);
            expect(stdout()).toContain("plr env set SERVICE NAME");
            expect(stdout()).not.toContain("plr auth login");
        }
        const { context, stdout } = await testContext();
        await run(["build-log", "--help"], context, clean);
        expect(stdout()).toContain("plr deployment logs");
    });

    it("prints the whole help for plr, plr help and --help on an unknown word", async () => {
        for (const argv of [[], ["help"], ["--help"], ["nope", "--help"]]) {
            const { context, stdout } = await testContext();
            await run(argv, context, clean);
            expect(stdout()).toBe(helpText());
        }
    });
});

describe("an old name on the command line", () => {
    it("runs the command and says the new name on stderr, leaving stdout alone", async () => {
        const { context, stdout, stderr } = await testContext();
        await run(["profiles"], context, clean);
        expect(stderr()).toBe(
            'plr: "plr profiles" is now "plr profile"; the old name keeps working.\n'
        );
        const now = await testContext();
        await run(["profile", "list"], now.context, clean);
        expect(stdout()).toBe(now.stdout());
        expect(now.stderr()).toBe("");
    });
});
