import { describe, expect, it } from "vitest";
import { shownMessages } from "@/lib/polar/code-messages";
import * as handoff from "@/lib/agents/session-handoff";

const note = handoff.buildHandoffNote({
    kind: "restore",
    sourceAgent: "Claude Code",
    targetAgent: "Claude Code",
    title: "Planner",
    repository: "acme/planner",
    branch: "polaris/x",
    at: new Date("2026-11-25T00:00:00Z"),
    originalTask: "Fix it",
    turns: [{ userRequest: "Fix it", agentResponse: "Done" }],
    fullHistoryPath: ""
});

describe("shownMessages", () => {
    it("never shows a carried handoff note, as a whole row or ahead of a prompt", () => {
        const rows = [
            { role: "system", body: handoff.RESUME_REFUSED_NOTICE },
            { role: "user", body: note },
            { role: "user", body: `${note}\n\nAdd tests` }
        ];
        expect(shownMessages(rows).map((row) => row.body)).toEqual([handoff.RESUME_REFUSED_NOTICE, "Add tests"]);
    });

    it("drops an unclosed note whole", () => {
        expect(shownMessages([{ role: "user", body: "<polaris-handoff>\n## Latest turn\nclipped" }])).toEqual([]);
    });

    it("collapses an agent answer stored twice in a row, keeps a repeated user line", () => {
        const rows = [
            { role: "user", body: "go" },
            { role: "agent", body: "Answer one" },
            { role: "agent", body: "Answer one " },
            { role: "user", body: "go" },
            { role: "user", body: "go" },
            { role: "agent", body: "Answer two" },
            { role: "agent", body: "Answer two" }
        ];
        expect(shownMessages(rows).map((row) => `${row.role}:${row.body}`)).toEqual([
            "user:go",
            "agent:Answer one",
            "user:go",
            "user:go",
            "agent:Answer two"
        ]);
    });

    it("leaves ordinary text alone", () => {
        const rows = [{ role: "user", body: "talk about <polaris-handoff> tags" }];
        expect(shownMessages(rows)[0]).toBe(rows[0]);
    });
});
