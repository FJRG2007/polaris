// @vitest-environment jsdom
/**
 * The preview beside a Code thread: it comes forward when the session starts a
 * web server, reloads once a burst of the agent's writes settles, and draws the
 * page at a phone's or a tablet's width. Fixture data throughout.
 */

import { withMessages } from "../../setup/i18n";
import type { SessionView } from "@/lib/agents/session-service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const ports = { open: [] as number[] };

vi.mock("@/components/agents/sessions/sessions-polls", () => ({
    sessionPreview: async () => ({
        answer: { kind: "ports", base: "/api/agents/preview/s-1/sig", open: ports.open, inside: [] }
    }),
    sessionFiles: async () => ({ answer: { kind: "files", files: [], truncated: false } })
}));
vi.mock("@/components/agents/sessions/actions", () => ({ openAgentInterfaceAction: async () => ({}) }));
vi.mock("@/components/agents/sessions/session-changes", () => ({ SessionChanges: () => null }));
vi.mock("@/components/agents/sessions/session-pr-tab", () => ({ SessionPullTab: () => null }));
vi.mock("@/app/(app)/apps/deploy/terminal-panel", () => ({ TerminalPanel: () => null }));

const { PolarCodeWorkspace } = await import("@/components/polar/polar-code-workspace");

const SESSION = { id: "s-1", title: "Fixture task", repoFullName: "", state: "working" } as unknown as SessionView;

function draw(lastEdit: string | null) {
    return withMessages(
        <PolarCodeWorkspace open onOpenChange={() => undefined} session={SESSION} branch="" live lastEdit={lastEdit} />
    );
}

beforeEach(() => {
    ports.open = [];
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("PolarCodeWorkspace preview", () => {
    it("brings the preview forward when the session serves a page", async () => {
        ports.open = [5173];
        render(draw(null));
        const frame = await screen.findByTitle("Preview of port 5173");
        expect(frame.getAttribute("src")).toBe("/api/agents/preview/s-1/sig/5173/");
        // Never the parent's origin.
        expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    });

    it("reloads once the agent's writes settle, not on the edit already shown", async () => {
        ports.open = [3000];
        const view = render(draw("2026-11-16T10:00:00.000Z"));
        const first = await screen.findByTitle("Preview of port 3000");
        vi.useFakeTimers();
        await act(async () => {
            vi.advanceTimersByTime(5_000);
        });
        expect(screen.getByTitle("Preview of port 3000")).toBe(first);

        view.rerender(draw("2026-11-16T10:00:01.000Z"));
        view.rerender(draw("2026-11-16T10:00:02.000Z"));
        await act(async () => {
            vi.advanceTimersByTime(500);
        });
        expect(screen.getByTitle("Preview of port 3000")).toBe(first);
        await act(async () => {
            vi.advanceTimersByTime(1_500);
        });
        expect(screen.getByTitle("Preview of port 3000")).not.toBe(first);
    });

    it("leaves the page alone when following the agent's writes is off", async () => {
        ports.open = [3000];
        const view = render(draw(null));
        const first = await screen.findByTitle("Preview of port 3000");
        fireEvent.click(screen.getByRole("switch", { name: "Reload when the agent changes a file" }));
        vi.useFakeTimers();
        view.rerender(draw("2026-11-16T10:00:01.000Z"));
        await act(async () => {
            vi.advanceTimersByTime(5_000);
        });
        expect(screen.getByTitle("Preview of port 3000")).toBe(first);
    });

    it("draws the page at a phone's width", async () => {
        ports.open = [3000];
        render(draw(null));
        const frame = await screen.findByTitle("Preview of port 3000");
        expect(frame.style.width).toBe("");
        fireEvent.click(screen.getByRole("radio", { name: "Phone" }));
        expect(screen.getByTitle("Preview of port 3000").style.width).toBe("375px");
    });
});
