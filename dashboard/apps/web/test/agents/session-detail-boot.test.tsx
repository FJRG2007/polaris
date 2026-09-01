// @vitest-environment jsdom

/**
 * The boot progress card on a session's own page.
 *
 * `bootProgress` (asserted in `session-commands.test.ts`) is a pure reading of
 * the terminal; this is the other half - that a starting session actually polls
 * its screen, feeds it through that reading, and puts the bar and the step list
 * on screen instead of the word-and-spinner this replaced. The agent's own
 * terminal panel is stubbed, since mounting a real one pulls in xterm for a
 * question this test is not asking.
 */

import type { SessionView } from "@/lib/agents/session-service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const sessionScreenAction = vi.fn(async () => ({ screen: "polaris: fetching FJRG2007/polaris" }));

// jsdom does not implement it, and the transcript scrolls to its own bottom on
// every render - a component this test never asked about.
beforeEach(() => {
    Element.prototype.scrollIntoView = () => undefined;
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("../../src/app/(app)/apps/agents/sessions/actions", () => ({
    promptSessionAction: vi.fn(async () => ({})),
    interruptSessionAction: vi.fn(async () => ({})),
    stopSessionAction: vi.fn(async () => ({})),
    sessionScreenAction: (...args: unknown[]) => sessionScreenAction(...args)
}));
vi.mock("../../src/app/(app)/apps/deploy/terminal-panel", () => ({ TerminalPanel: () => null }));

const { SessionDetail } = await import(
    "../../src/app/(app)/apps/agents/sessions/[sessionId]/session-detail"
);

function workspaceSession(overrides: Partial<SessionView> = {}): SessionView {
    return {
        id: "sess-1",
        title: "My machine",
        ownerId: "usr_1",
        // A workspace: no repository, no branch to speak of.
        repoId: null,
        repoFullName: "",
        cli: "claude",
        command: null,
        place: "local",
        sharedHome: false,
        unattended: null,
        accountId: null,
        hostId: null,
        hostName: null,
        state: "starting",
        detail: "",
        branch: "",
        baseRef: "",
        taskId: null,
        error: null,
        lastEventAt: null,
        startedAt: null,
        finishedAt: null,
        createdAt: "2026-09-01T00:00:00.000Z",
        ...overrides
    };
}

afterEach(() => {
    cleanup();
    sessionScreenAction.mockClear();
});

describe("the boot progress card", () => {
    it("reads the session's own terminal and turns it into a bar and a step list", async () => {
        render(<SessionDetail session={workspaceSession()} events={[]} messages={[]} />);

        await waitFor(() => expect(screen.getByText("Getting the machine ready.")).toBeTruthy());

        // Fetch is under way, so the step before it is done and the ones after
        // are still waiting - the ordering `bootProgress` computes from one line.
        expect(screen.getByText("Preparing your machine").closest("li")?.textContent).toContain(
            "Preparing your machine"
        );
        expect(screen.getByText("Fetching the repository")).toBeTruthy();
        expect(screen.getByText("Installing the agent")).toBeTruthy();
        expect(sessionScreenAction).toHaveBeenCalledWith("sess-1");
    });

    it("shows nothing once the agent has the terminal", async () => {
        sessionScreenAction.mockResolvedValueOnce({ screen: "polaris: starting claude" });
        render(
            <SessionDetail
                session={workspaceSession({ state: "working" })}
                events={[]}
                messages={[]}
            />
        );

        await waitFor(() => expect(sessionScreenAction).not.toHaveBeenCalled());
        expect(screen.queryByText("Getting the machine ready.")).toBeNull();
    });
});
