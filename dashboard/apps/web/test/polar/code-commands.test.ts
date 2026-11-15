/**
 * Code's "/" commands: which are on offer where, how a typed one is read, and
 * how a handed-over one is spelled for each CLI.
 */

import { describe, expect, it } from "vitest";
import * as codeCommands from "@/lib/polar/code-commands";
import { codeSlashMatches } from "@/components/polar/polar-code-slash";
import { automaticChoice, type PolarCommandRow } from "@/lib/polar/shared";
import * as enigmaSlash from "@/lib/polar/enigma-slash";

describe("the commands on offer", () => {
    it("starts a task with its own commands only", () => {
        expect(codeCommands.codeCommandsFor("start", null)).toEqual(["help", "resume", "model", "clear"]);
    });

    it("gives a Claude Code session every handed-over command", () => {
        expect(codeCommands.codeCommandsFor("thread", "claude")).toEqual([
            "help",
            "new",
            "resume",
            "clear",
            "compact",
            "review",
            "security-review",
            "init",
            "stop",
            "rename",
            "diff",
            "context",
            "export",
            "goal",
            "plan",
            "simplify",
            "copy",
            "exit"
        ]);
    });

    it("gives another CLI only what it has, and an unknown one only Polaris's own", () => {
        const codex = codeCommands.codeCommandsFor("thread", "codex");
        expect(codex).toContain("compact");
        expect(codex).toContain("clear");
        expect(codex).not.toContain("review");
        expect(codex).not.toContain("security-review");
        expect(codeCommands.codeCommandsFor("thread", "aider")).toEqual([
            "help",
            "new",
            "resume",
            "stop",
            "rename",
            "diff",
            "context",
            "export",
            "goal",
            "copy",
            "exit"
        ]);
        expect(codeCommands.codeCommandsFor("thread", null)).not.toContain("compact");
    });
});

describe("a command typed whole", () => {
    const claude = codeCommands.codeCommandsFor("thread", "claude");

    it("reads the name and what follows it", () => {
        expect(codeCommands.codeCommandIn("/compact keep the API notes", claude)).toEqual({
            command: "compact",
            rest: "keep the API notes"
        });
        expect(codeCommands.codeCommandIn("  /STOP  ", claude)).toEqual({ command: "stop", rest: "" });
        expect(codeCommands.codeCommandIn("/security-review", claude)).toEqual({
            command: "security-review",
            rest: ""
        });
    });

    it("leaves anything else as a message", () => {
        expect(codeCommands.codeCommandIn("please /compact", claude)).toBeNull();
        expect(codeCommands.codeCommandIn("/compactor", claude)).toBeNull();
        expect(codeCommands.codeCommandIn("/model", claude)).toBeNull();
        expect(codeCommands.codeCommandIn("", claude)).toBeNull();
    });
});

describe("a handed-over command", () => {
    it("is spelled the way each CLI spells it", () => {
        expect(codeCommands.forwardedText("clear", "", "claude")).toBe("/clear");
        expect(codeCommands.forwardedText("clear", "", "codex")).toBe("/new");
        expect(codeCommands.forwardedText("clear", "", "opencode")).toBe("/new");
        expect(codeCommands.forwardedText("compact", "", "gemini")).toBe("/compress");
        expect(codeCommands.forwardedText("init", "", "codex")).toBe("/init");
    });

    it("keeps the words after it only where the CLI takes them", () => {
        expect(codeCommands.forwardedText("compact", "keep the plan", "claude")).toBe(
            "/compact keep the plan"
        );
        expect(codeCommands.forwardedText("review", "123", "claude")).toBe("/review 123");
        expect(codeCommands.forwardedText("compact", "keep the plan", "codex")).toBe("/compact");
        expect(codeCommands.forwardedText("init", "extra", "claude")).toBe("/init");
    });

    it("is nothing for Polaris's own commands or a CLI without it", () => {
        expect(codeCommands.forwardedText("stop", "", "claude")).toBeNull();
        expect(codeCommands.forwardedText("review", "", "codex")).toBeNull();
    });
});

describe("the list", () => {
    const own: PolarCommandRow[] = [
        { id: "1", shortcut: "review", prompt: "Mine", choice: automaticChoice() },
        { id: "2", shortcut: "standup", prompt: "Write the standup", choice: automaticChoice() }
    ];
    const commands = codeCommands.codeCommandsFor("thread", "claude");

    it("puts Code's commands first and hides a person's own of the same name", () => {
        const found = codeSlashMatches("/", [], own, commands);
        expect(found.slice(0, commands.length).every((match) => match.kind === "command")).toBe(true);
        expect(found.filter((match) => match.kind === "own")).toEqual([{ kind: "own", row: own[1] }]);
    });

    it("narrows as you type, best match first, and closes on a space", () => {
        expect(codeSlashMatches("/st", [], own, commands)[0]).toEqual({ kind: "command", command: "stop" });
        expect(codeSlashMatches("/sec", [], [], commands)).toEqual([
            { kind: "command", command: "security-review" }
        ]);
        expect(codeSlashMatches("/stop now", [], own, commands)).toEqual([]);
    });
});

describe("Enigma's commands on each surface", () => {
    const catalogue = [
        { name: "gate", description: "Validate changes.", argumentHint: "[task]", chat: false },
        { name: "handoff", description: "Hand over.", argumentHint: null, chat: false },
        { name: "recap", description: "Sum up.", argumentHint: null, chat: true },
        { name: "review", description: "Shadowed.", argumentHint: null, chat: true }
    ];
    const strip = ({ name, description, argumentHint }: (typeof catalogue)[number]) => ({
        name,
        description,
        argumentHint
    });

    it("offers Code every command and Chat only those that need no checkout", () => {
        expect(enigmaSlash.enigmaSlashFor(catalogue, "code")).toEqual(catalogue.map(strip));
        expect(enigmaSlash.enigmaSlashFor(catalogue, "chat").map((entry) => entry.name)).toEqual([
            "recap",
            "review"
        ]);
    });

    it("lists them after the person's own in Code, behind any name already taken", () => {
        const enigma = enigmaSlash.enigmaSlashFor(catalogue, "code");
        const own: PolarCommandRow[] = [{ id: "1", shortcut: "handoff", prompt: "Mine", choice: automaticChoice() }];
        const found = codeSlashMatches("/", [{ name: "recap", description: "skill" }], own, ["review"], enigma);
        expect(found.filter((match) => match.kind === "enigma")).toEqual([
            { kind: "enigma", command: strip(catalogue[0]!) }
        ]);
        expect(found.at(-1)?.kind).toBe("enigma");
        expect(codeSlashMatches("/ga", [], [], [], enigma)).toEqual([{ kind: "enigma", command: strip(catalogue[0]!) }]);
        expect(codeSlashMatches("/gate now", [], [], [], enigma)).toEqual([]);
    });

    it("reads back only well-formed rows from a cache", () => {
        expect(
            enigmaSlash.readEnigmaLists({ code: [{ name: "gate", description: "d" }, { name: 1 }], chat: "x" })
        ).toEqual({ code: [{ name: "gate", description: "d", argumentHint: null }], chat: [] });
        expect(enigmaSlash.readEnigmaLists(null)).toEqual(enigmaSlash.NO_ENIGMA_COMMANDS);
    });
});

describe("the commands added for Claude Code parity", () => {
    const claude = codeCommands.codeCommandsFor("thread", "claude");
    const codex = codeCommands.codeCommandsFor("thread", "codex");

    it("runs /goal, /copy and /exit in Polaris for every CLI, never at the start", () => {
        for (const command of ["goal", "copy", "exit"] as const) {
            expect(codex).toContain(command);
            expect(codeCommands.forwardedText(command, "x", "claude")).toBeNull();
            expect(codeCommands.codeCommandsFor("start", null)).not.toContain(command);
        }
    });

    it("reads a goal's condition after /goal and keeps it for the box", () => {
        expect(codeCommands.codeCommandIn("/goal all tests pass\nand lint is clean", claude)).toEqual({
            command: "goal",
            rest: "all tests pass\nand lint is clean"
        });
        expect(codeCommands.takesText("goal")).toBe(true);
    });

    it("hands /plan and /simplify to Claude Code only, with their words", () => {
        expect(codeCommands.forwardedText("plan", "fix the auth bug", "claude")).toBe("/plan fix the auth bug");
        expect(codeCommands.forwardedText("simplify", "", "claude")).toBe("/simplify");
        expect(codeCommands.forwardedText("plan", "x", "codex")).toBeNull();
        expect(codex).not.toContain("plan");
        expect(codex).not.toContain("simplify");
    });

    it("picks which answer /copy copies", () => {
        expect(codeCommands.copyIndex("")).toBe(1);
        expect(codeCommands.copyIndex(" 2 ")).toBe(2);
        expect(codeCommands.copyIndex("0")).toBeNull();
        expect(codeCommands.copyIndex("-1")).toBeNull();
        expect(codeCommands.copyIndex("two")).toBeNull();
    });
});
