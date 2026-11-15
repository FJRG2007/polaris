/**
 * A Code transcript downloads as Markdown to read and JSONL to process, both
 * holding every message and step in order.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import { transcriptFile, transcriptJsonl, transcriptMarkdown } from "@/lib/polar/code-transcript";

const SESSION = {
    id: "0190a2b4-0000-7000-8000-000000000001",
    title: "Fix the login form",
    repo: "acme/web",
    branch: "polaris/fix-login",
    cli: "claude",
    createdAt: "2026-11-15T10:00:00.000Z"
};

const ENTRIES = [
    { at: "2026-11-15T10:00:01.000Z", type: "message" as const, role: "user", text: "Fix it", detail: "" },
    { at: "2026-11-15T10:00:02.000Z", type: "event" as const, role: "tool.start", text: "Read", detail: "src/login.tsx" },
    { at: "2026-11-15T10:00:03.000Z", type: "event" as const, role: "tool.start", text: "Edit", detail: "a\nb" },
    { at: "2026-11-15T10:00:04.000Z", type: "message" as const, role: "agent", text: "Done.", detail: "" }
];

const NAMES = {
    you: "You",
    agent: "Agent",
    polaris: "Polaris",
    repository: "Repository",
    branch: "Branch",
    started: "Started",
    steps: "Steps"
};

describe("transcriptMarkdown", () => {
    it("heads the file with the session and keeps messages and steps in order", () => {
        const text = transcriptMarkdown(SESSION, ENTRIES, NAMES);
        expect(text).toBe(
            [
                "# Fix the login form",
                "",
                "- Repository: acme/web",
                "- Branch: polaris/fix-login",
                "- Started: 2026-11-15T10:00:00.000Z",
                "",
                "## You - 2026-11-15T10:00:01.000Z",
                "",
                "Fix it",
                "",
                "**Steps**",
                "",
                "- Read: src/login.tsx",
                "- Edit: a b",
                "",
                "## Agent - 2026-11-15T10:00:04.000Z",
                "",
                "Done.",
                ""
            ].join("\n")
        );
    });
});

describe("transcriptJsonl", () => {
    it("is a session line, then one parseable line per entry", () => {
        const lines = transcriptJsonl(SESSION, ENTRIES).trimEnd().split("\n");
        expect(lines).toHaveLength(ENTRIES.length + 1);
        expect(JSON.parse(lines[0]!)).toMatchObject({ type: "session", version: 1, id: SESSION.id });
        expect(lines.slice(1).map((line) => JSON.parse(line))).toEqual(ENTRIES);
    });
});

describe("transcriptFile", () => {
    it("names the file after the session, with the format's type", () => {
        expect(transcriptFile(SESSION, "md")).toEqual({
            name: "fix-the-login-form-0190a2b4.md",
            type: "text/markdown; charset=utf-8"
        });
        expect(transcriptFile(SESSION, "jsonl").name).toBe("fix-the-login-form-0190a2b4.jsonl");
    });
});
