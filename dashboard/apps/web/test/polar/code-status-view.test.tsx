// @vitest-environment jsdom
/**
 * The Code dock's reported parts: queued messages stay editable and can be
 * taken back, the status line reads in the reader's words, and "/context"
 * shows what fills the window or says plainly that nothing was reported.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CodeContextCard, CodeQueuedList, CodeStatusLine, transcriptHref } from "@/components/polar/polar-code-status";

afterEach(cleanup);

const WAITING = [
    { id: "q1", text: "then add tests", at: "2026-11-15T10:00:05.000Z", files: 0 },
    { id: "q2", text: "and update the docs", at: "2026-11-15T10:00:06.000Z", files: 2 }
];

describe("CodeQueuedList", () => {
    function list(props: Partial<Parameters<typeof CodeQueuedList>[0]> = {}) {
        const calls = {
            onEdit: vi.fn(),
            onTakeBack: vi.fn(),
            onMove: vi.fn(),
            onSendNow: vi.fn(),
            onStopAll: vi.fn()
        };
        const view = render(
            <CodeQueuedList
                waiting={WAITING}
                steers={false}
                disabled={false}
                {...calls}
                onStopAll={null}
                {...props}
            />,
            { wrapper: MessagesWrapper }
        );
        return { ...calls, ...view };
    }

    function button(name: string, index = 0) {
        return screen.getAllByRole("button", { name })[index]!;
    }

    it("lists the waiting messages in order, with their files", () => {
        list();
        const items = screen.getAllByRole("listitem");
        expect(items[0]?.textContent).toContain("then add tests");
        expect(items[1]?.textContent).toContain("+2 files");
    });

    it("takes one back, and saves an edit only once the words changed", async () => {
        const { onEdit, onTakeBack } = list();
        fireEvent.click(button("Take back", 1));
        expect(onTakeBack).toHaveBeenCalledWith("q2");
        fireEvent.click(button("Edit", 0));
        const save = await screen.findByRole("button", { name: "Save" });
        expect(save).toHaveProperty("disabled", true);
        fireEvent.change(screen.getByRole("textbox", { name: "Edit" }), { target: { value: "then add more tests" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(onEdit).toHaveBeenCalledWith("q1", "then add more tests");
    });

    it("moves one down from its menu", async () => {
        const { onMove } = list();
        fireEvent.pointerDown(button("Message options", 0), { button: 0, ctrlKey: false, pointerType: "mouse" });
        fireEvent.click(await screen.findByText("Move down"));
        expect(onMove).toHaveBeenCalledWith("q1", "down");
    });

    it("says Send now where the message joins the running turn, and that it stops the turn where it cannot", () => {
        const steering = list({ steers: true });
        fireEvent.click(button("Send now", 0));
        expect(steering.onSendNow).toHaveBeenCalledWith("q1");
        steering.unmount();
        list({ steers: false });
        expect(button("Stop the turn and send this now", 0)).toBeTruthy();
    });

    it("offers no Send now where nobody may steer the session", () => {
        list({ onSendNow: null });
        expect(button("Edit", 0)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Stop the turn and send this now" })).toBeNull();
    });

    it("offers Stop, send nothing only mid-turn", () => {
        list({ onStopAll: vi.fn() });
        expect(screen.getByRole("button", { name: "Stop, send nothing" })).toBeTruthy();
        cleanup();
        list();
        expect(screen.queryByRole("button", { name: "Stop, send nothing" })).toBeNull();
    });

    it("draws nothing when nothing waits", () => {
        const { container } = list({ waiting: [] });
        expect(container.textContent).toBe("");
    });
});

describe("CodeStatusLine", () => {
    it("reads each part in the reader's words", () => {
        render(
            <CodeStatusLine
                parts={[
                    { kind: "model", value: "claude-sonnet-4-5" },
                    { kind: "effort", value: "high" },
                    { kind: "context", percent: 25 },
                    { kind: "branch", value: "polaris/fix" }
                ]}
            />,
            { wrapper: MessagesWrapper }
        );
        const line = screen.getByRole("status", { name: "Session status" });
        expect(line.textContent).toContain("claude-sonnet-4-5");
        expect(line.textContent).toContain("high effort");
        expect(line.textContent).toContain("25% context");
        expect(line.textContent).toContain("polaris/fix");
    });
});

describe("CodeContextCard", () => {
    it("splits the last turn by kind", () => {
        render(
            <CodeContextCard
                context={{
                    used: 46_000,
                    window: 200_000,
                    parts: { input: 1000, cacheRead: 40_000, cacheWrite: 5000, output: 4000 }
                }}
                model="claude-sonnet-4-5-20250929"
                onClose={vi.fn()}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByText(/\(23%\)/)).toBeTruthy();
        expect(screen.getByText("Cache reads")).toBeTruthy();
        expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("23");
    });

    it("says so when no turn reported its size", () => {
        render(<CodeContextCard context={null} model={null} onClose={vi.fn()} />, { wrapper: MessagesWrapper });
        expect(screen.getByText("No turn has reported its size yet.")).toBeTruthy();
    });
});

describe("transcriptHref", () => {
    it("names the session and the format", () => {
        expect(transcriptHref("s1", "jsonl")).toBe("/api/polar/code/transcript?sessionId=s1&format=jsonl");
    });
});
