// @vitest-environment jsdom
/**
 * The changes beside a Code thread follow the agent: each write it finishes
 * reads the list and the open diff again, marks the files it just changed, and
 * opens the newest one when nothing is open. Fixture data throughout.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { SessionView } from "@/lib/agents/session-service";
import type { ChangedFile } from "@/lib/agents/session-changes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const state = { files: [] as ChangedFile[], lists: 0, diffs: [] as string[] };

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("@/components/agents/sessions/sessions-polls", () => ({
    sessionChanges: async () => {
        state.lists++;
        return {
            answer: {
                kind: "listing",
                listing: { kind: "ok", total: state.files.length, files: state.files, next: null }
            }
        };
    }
}));
vi.mock("@/components/agents/sessions/actions", () => ({
    sessionFileDiffAction: async ({ path }: { path: string }) => {
        state.diffs.push(path);
        return { answer: { kind: "diff", diff: { kind: "diff", text: `--- a/${path}\n+++ b/${path}\n+new line\n` } } };
    },
    sendReviewCommentsAction: async () => ({}),
    openSessionPullRequestAction: async () => ({}),
    sessionShipAction: async () => ({})
}));

const { SessionChanges, movedFiles } = await import("@/components/agents/sessions/session-changes");

const SESSION = { id: "s-1", state: "working", branch: "agent/fixture" } as unknown as SessionView;
const draw = (wake: string | null | undefined) => <SessionChanges session={SESSION} wake={wake} />;
const show = (wake: string | null | undefined) => render(draw(wake), { wrapper: MessagesWrapper });

beforeEach(() => {
    state.files = [{ path: "src/app.tsx", added: 2, removed: 0 }];
    state.lists = 0;
    state.diffs = [];
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("movedFiles", () => {
    it("is the files new or with other counts, and nothing on a first read", () => {
        const before = [
            { path: "a.ts", added: 1, removed: 0 },
            { path: "b.ts", added: 3, removed: 1 }
        ];
        expect(movedFiles(null, before)).toEqual(new Set());
        expect(
            movedFiles(before, [
                { path: "a.ts", added: 1, removed: 0 },
                { path: "b.ts", added: 4, removed: 1 },
                { path: "c.ts", added: 1, removed: 0 }
            ])
        ).toEqual(new Set(["b.ts", "c.ts"]));
    });
});

describe("SessionChanges following the agent", () => {
    it("reads again on each write the agent finishes, and opens what it just changed", async () => {
        const view = show("2026-11-16T10:00:00.000Z");
        await screen.findByText("src/app.tsx");
        expect(state.lists).toBe(1);
        expect(screen.queryByRole("img", { name: "Just changed" })).toBeNull();

        state.files = [
            { path: "src/app.tsx", added: 2, removed: 0 },
            { path: "src/page.tsx", added: 5, removed: 1 }
        ];
        view.rerender(draw("2026-11-16T10:00:01.000Z"));
        await waitFor(() => expect(state.lists).toBe(2));
        expect((await screen.findAllByRole("button", { name: /src\/page\.tsx/ })).length).toBeGreaterThan(0);
        expect(screen.getAllByRole("img", { name: "Just changed" })).toHaveLength(1);
        await waitFor(() => expect(state.diffs).toContain("src/page.tsx"));

        // The open diff is read again on the next write.
        state.files = [
            { path: "src/app.tsx", added: 2, removed: 0 },
            { path: "src/page.tsx", added: 7, removed: 1 }
        ];
        view.rerender(draw("2026-11-16T10:00:02.000Z"));
        await waitFor(() => expect(state.diffs.filter((path) => path === "src/page.tsx")).toHaveLength(2));
    });

    it("gathers a burst of writes into one read", async () => {
        const view = show("2026-11-16T10:00:00.000Z");
        await screen.findByText("src/app.tsx");
        vi.useFakeTimers();
        view.rerender(draw("2026-11-16T10:00:01.000Z"));
        view.rerender(draw("2026-11-16T10:00:02.000Z"));
        view.rerender(draw("2026-11-16T10:00:03.000Z"));
        await act(async () => {
            vi.advanceTimersByTime(1_000);
        });
        expect(state.lists).toBe(2);
    });
});
