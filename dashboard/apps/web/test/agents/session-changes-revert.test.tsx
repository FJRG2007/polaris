// @vitest-environment jsdom
/**
 * Accepting and reverting in the session's changes: per file and per hunk,
 * a revert only after the app's own confirm dialog, and an accept that folds a
 * hunk away without touching the checkout. Fixture data throughout.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { SessionView } from "@/lib/agents/session-service";
import { hunkId } from "@/lib/agents/session-changes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const HUNKS = ["@@ -1,1 +1,1 @@\n-a\n+A\n", "@@ -9,1 +9,1 @@\n-z\n+Z\n"];
const DIFF = `diff --git a/src/app.tsx b/src/app.tsx\n--- a/src/app.tsx\n+++ b/src/app.tsx\n${HUNKS.join("")}`;
const state = { reverts: [] as unknown[], lists: 0 };

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/components/agents/sessions/sessions-polls", () => ({
    sessionChanges: async () => {
        state.lists++;
        return {
            answer: {
                kind: "listing",
                listing: { kind: "ok", total: 1, files: [{ path: "src/app.tsx", added: 2, removed: 2 }], next: null }
            }
        };
    }
}));
vi.mock("@/components/agents/sessions/actions", () => ({
    sessionFileDiffAction: async () => ({ answer: { kind: "diff", diff: { kind: "diff", text: DIFF } } }),
    revertSessionChangeAction: async (input: unknown) => {
        state.reverts.push(input);
        return { answer: { kind: "done", result: "reverted" } };
    },
    sendReviewCommentsAction: async () => ({}),
    openSessionPullRequestAction: async () => ({}),
    sessionShipAction: async () => ({})
}));

const { SessionChanges } = await import("@/components/agents/sessions/session-changes");

const SESSION = { id: "s-1", state: "working", branch: "agent/fixture" } as unknown as SessionView;

async function openFile() {
    render(<SessionChanges session={SESSION} />, { wrapper: MessagesWrapper });
    fireEvent.click(await screen.findByRole("button", { name: /src\/app\.tsx/ }));
    await screen.findByRole("region", { name: "Change 2" });
}

beforeEach(() => {
    state.reverts = [];
    state.lists = 0;
});
afterEach(cleanup);

describe("SessionChanges accept and revert", () => {
    it("reverts one hunk only after the confirm dialog, naming it by place and text", async () => {
        await openFile();
        const second = screen.getByRole("region", { name: "Change 2" });
        fireEvent.click(within(second).getByRole("button", { name: "Revert this change" }));
        const dialog = await screen.findByRole("dialog");
        expect(state.reverts).toEqual([]);
        fireEvent.click(within(dialog).getByRole("button", { name: "Revert" }));
        await waitFor(() =>
            expect(state.reverts).toEqual([
                { sessionId: "s-1", path: "src/app.tsx", hunk: { index: 1, id: hunkId(HUNKS[1]!) } }
            ])
        );
        // The list is read again after it.
        await waitFor(() => expect(state.lists).toBeGreaterThan(1));
    });

    it("does nothing when the dialog is cancelled", async () => {
        await openFile();
        fireEvent.click(screen.getByRole("button", { name: "Revert this file" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(state.reverts).toEqual([]);
    });

    it("reverts the whole file without a hunk", async () => {
        await openFile();
        fireEvent.click(screen.getByRole("button", { name: "Revert this file" }));
        fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revert" }));
        await waitFor(() => expect(state.reverts).toEqual([{ sessionId: "s-1", path: "src/app.tsx" }]));
    });

    it("folds an accepted hunk away and marks an accepted file, without a revert", async () => {
        await openFile();
        const first = screen.getByRole("region", { name: "Change 1" });
        fireEvent.click(within(first).getByRole("button", { name: "Accept this change" }));
        expect(within(first).getByRole("button", { name: "Accept this change" }).getAttribute("aria-pressed")).toBe("true");
        expect(within(first).queryByLabelText(/src\/app\.tsx/)).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Accept this file" }));
        expect(screen.getAllByRole("img", { name: "Accepted" }).length).toBeGreaterThan(0);
        expect(state.reverts).toEqual([]);
    });
});
