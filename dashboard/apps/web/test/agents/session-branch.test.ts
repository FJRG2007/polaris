import { describe, expect, it } from "vitest";
import { createdSessionBranch, isChangeEvent, shownSessionBranch } from "@/lib/agents/session-branch";

const ID = "6364280b-0000-4000-8000-000000000000";

const repoSession = {
    repoFullName: "acme/site",
    branch: "agent/fix-login-6364280b",
    work: null,
    pullRequest: null
};

describe("createdSessionBranch", () => {
    it("mints none for a session without a repository", () => {
        expect(createdSessionBranch(ID, null, "Hola que tal?")).toBe("");
    });

    it("names the branch from the title for a repository session", () => {
        expect(createdSessionBranch(ID, "repo-id", "Fix login")).toBe("agent/fix-login-6364280b");
    });
});

describe("shownSessionBranch", () => {
    it("shows nothing for a session without a repository, whatever its row says", () => {
        expect(
            shownSessionBranch({ ...repoSession, repoFullName: "", branch: "agent/hola-que-tal-6364280b" })
        ).toBe("");
    });

    it("shows nothing for a repository session that only talked", () => {
        const events = [
            { kind: "session.start", subject: "", detail: "" },
            { kind: "prompt", subject: "", detail: "Hola que tal?" },
            { kind: "tool.start", subject: "Read", detail: "src/index.ts" },
            { kind: "tool.start", subject: "Bash", detail: "git status" },
            { kind: "turn.end", subject: "", detail: "" }
        ];
        expect(shownSessionBranch(repoSession, events)).toBe("");
    });

    it("shows the branch once a file was edited", () => {
        const events = [{ kind: "tool.start", subject: "Edit", detail: "src/login.ts" }];
        expect(shownSessionBranch(repoSession, events)).toBe(repoSession.branch);
    });

    it("shows the branch once something was committed", () => {
        const events = [{ kind: "tool.end", subject: "Bash", detail: 'git commit -m "fix"' }];
        expect(shownSessionBranch(repoSession, events)).toBe(repoSession.branch);
    });

    it("shows the branch for saved work or a pull request", () => {
        expect(
            shownSessionBranch({ ...repoSession, work: { state: "pushed", commits: 2 } })
        ).toBe(repoSession.branch);
        expect(
            shownSessionBranch({ ...repoSession, work: { state: "kept", commits: 1 } })
        ).toBe(repoSession.branch);
        expect(shownSessionBranch({ ...repoSession, pullRequest: { number: 4, url: "x" } })).toBe(
            repoSession.branch
        );
        expect(
            shownSessionBranch({ ...repoSession, work: { state: "clean", commits: 0 } })
        ).toBe("");
    });
});

describe("isChangeEvent", () => {
    it("ignores events that are not tools", () => {
        expect(isChangeEvent({ kind: "prompt", subject: "Edit", detail: "" })).toBe(false);
    });
});
