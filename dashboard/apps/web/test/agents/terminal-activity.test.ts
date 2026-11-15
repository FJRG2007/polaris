import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import { hookActivity } from "@/lib/agents/hook-activity";
import { hasTerminalActivity, plainTerminalLines, terminalActivity } from "@/lib/agents/terminal-activity";

const screen = (...rows: string[]): string => rows.join("\n");

describe("plainTerminalLines", () => {
    it("drops escapes and control characters and keeps the rows", () => {
        expect(plainTerminalLines("\x1b[2m> \x1b[0mhello\r\n\x1b]0;title\x07next\x08")).toEqual(["> hello", "next"]);
    });

    it("reads only the end of a huge capture", () => {
        const lines = plainTerminalLines(`${"x".repeat(200_000)}\nlast`);
        expect(lines.at(-1)).toBe("last");
        expect(lines.join("").length).toBeLessThanOrEqual(15 * 1024);
    });
});

describe("terminalActivity", () => {
    it("is no signal for a tool without a reader, or an empty screen", () => {
        expect(hasTerminalActivity("claude")).toBe(false);
        expect(terminalActivity("claude", "> working")).toBeNull();
        expect(terminalActivity("aider", "")).toBeNull();
        for (const id of ["hermes", "minimax-code", "mimo-code"]) expect(hasTerminalActivity(id), id).toBe(false);
    });

    it("reads Aider's submitted prompt as work and a bare prompt as nothing", () => {
        expect(terminalActivity("aider", screen("Aider v0.86", "> fix the tests", ""))).toBe("active");
        expect(terminalActivity("aider", screen("architect multi> refactor it"))).toBe("active");
        expect(terminalActivity("aider", screen("> fix the tests", "Done.", ">"))).toBeNull();
        expect(terminalActivity("aider", screen("ask> "))).toBeNull();
        // Output that is not its prompt says nothing either.
        expect(terminalActivity("aider", screen("Applied edit to app.ts", "Commit 1a2b3c"))).toBeNull();
    });

    it("reads Continue's composer, its picker and its working status", () => {
        expect(terminalActivity("continue", screen("│ ❯ │"))).toBe("idle");
        expect(terminalActivity("continue", screen("● ▋Ask anything, @ for context"))).toBe("idle");
        expect(
            terminalActivity("continue", screen("⠋ Thinking… (esc to interrupt)", "● ▋Ask anything, @ for context"))
        ).toBe("active");
        expect(terminalActivity("continue", screen("Reading files", "esc to interrupt"))).toBe("active");
        const picker = screen("Ask question(Which database?)", "? Which database", "› Postgres", "↑↓ move · enter select");
        expect(terminalActivity("continue", picker)).toBe("waiting_input");
        // The same picker answered and followed by an empty composer is history.
        expect(terminalActivity("continue", screen(picker, "Postgres it is.", "│ ❯ │"))).toBe("idle");
        expect(terminalActivity("continue", screen("some transcript text"))).toBeNull();
    });

    it("reads Stakpak's footer, its approval box, and nothing else", () => {
        const box = (prompt: string, footer: string): string =>
            screen("┌──────────────────────┐", `│→ ${prompt}│`, "└──────────────────────┘", footer);
        expect(terminalActivity("stakpak", box("█Load test my service", "   $ shell | / commands | ctrl+s shortcuts"))).toBe(
            "idle"
        );
        expect(terminalActivity("stakpak", box("", " ⠋ working · esc cancel"))).toBe("active");
        expect(terminalActivity("stakpak", box("deploy it", " ctrl+j new line | enter send"))).toBeNull();
        // A box without its top border, or no footer row, is not the composer.
        expect(terminalActivity("stakpak", screen("│→ hi│", "└──────┘", "$ shell | / commands"))).toBeNull();
        expect(terminalActivity("stakpak", screen("┌────┐", "│→ hi│", "└────┘"))).toBeNull();
        const approval = screen(
            "┌ Approval Required ───────┐",
            "│ run_command: rm -rf dist │",
            "│ enter approve · esc reject all │",
            "└──────────────────────────┘"
        );
        expect(terminalActivity("stakpak", approval)).toBe("blocked");
    });

    it("never answers idle for an unrecognised screen", () => {
        const noise = ["", "\x1b[2J", "random text", "─".repeat(40), "> ", "│ │"];
        for (const id of ["aider", "continue", "stakpak"])
            for (const output of noise) expect(terminalActivity(id, output), `${id}: ${JSON.stringify(output)}`).not.toBe("idle");
    });
});

describe("Crush hooks and Aider's notification", () => {
    it("registers the events Crush documents in its project config", () => {
        const answer = core.hookFileAnswer("crush")!;
        expect(answer.file).toBe(`${core.HOOK_FILE_WORKDIR}.crush.json`);
        const hooks = (answer.assert as { hooks: Record<string, Array<{ command: string; timeout: number }>> }).hooks;
        expect(Object.keys(hooks)).toEqual([
            "SessionStart",
            "TurnStart",
            "PostToolUse",
            "PostToolUseFailure",
            "PermissionRequest",
            "PermissionResult",
            "TurnEnd",
            "StopFailure",
            "SessionEnd"
        ]);
        // No decision Crush waits on, and no matcher outside tool events.
        expect(hooks.PreToolUse).toBeUndefined();
        for (const [event, entries] of Object.entries(hooks)) {
            expect(entries, event).toHaveLength(1);
            expect(Object.keys(entries[0]!).sort()).toEqual(["command", "timeout"]);
        }
        expect(hooks.TurnEnd![0]!.command).toBe(core.hookCommand("stop"));
    });

    it("maps Crush's reported events to activity", () => {
        const read = (event: string): unknown => hookActivity("crush", { hook_event_name: event });
        expect(read("SessionStart")).toBe("idle");
        expect(read("UserPromptSubmit")).toBe("active");
        expect(read("PermissionRequest")).toBe("blocked");
        expect(read("PermissionResolved")).toBe("active");
        expect(read("Stop")).toBe("idle");
        expect(read("StopFailure")).toBe("waiting_input");
        expect(read("SessionEnd")).toBe("exited");
    });

    it("points Aider's notification command at a script that never reads its terminal", () => {
        const aider = core.AGENT_CLIS.find((entry) => entry.id === "aider")!;
        expect(aider.hookArgs).toEqual(["--notifications", "--notifications-command", core.AIDER_NOTIFY_SCRIPT]);
        const [answer] = core.hookFileAnswers("aider");
        expect(answer!.file).toBe(`${core.HOOK_FILE_WORKDIR}${core.AIDER_NOTIFY_SCRIPT}`);
        expect(answer!.executable).toBe(true);
        expect(answer!.text).toContain(`(${core.hookCommand("stop")}) </dev/null >/dev/null 2>&1`);
        expect(hookActivity("aider", { hook_event_name: "Stop" })).toBe("waiting_input");
        expect(hookActivity("aider", { hook_event_name: "UserPromptSubmit" })).toBeNull();
    });
});
