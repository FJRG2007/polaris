// @vitest-environment jsdom

/**
 * A long conversation pays for one message menu, not for every row's.
 *
 * Each row used to build its thirty actions, their hooks and a reminder dialog
 * on every render of the list, whether or not anybody right-clicked it, and the
 * menu opened modal - the page locked and hidden from assistive technology on
 * every open - and faded in from nothing. What is asserted here: a row that has
 * not been opened builds no actions, opening one builds that row's alone, the
 * menu does not lock the page, and it opens with no entrance animation. The
 * timings are printed for the record and bounded loosely, so a slow machine
 * does not fail the suite while a return to the old cost would.
 */

import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import type { ChatMessageView } from "@/lib/chat/messages";
import { MessageMenu } from "@/app/(app)/chat/message-menu";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const scheduleRenders = vi.fn();
vi.mock("@/app/(app)/chat/schedule-dialog", () => ({
    ScheduleDialog: () => {
        scheduleRenders();
        return null;
    }
}));
vi.mock("@/app/(app)/chat/actions", () => ({ setReminderAction: vi.fn() }));

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
    cleanup();
    scheduleRenders.mockClear();
});

const ROWS = 500;

function message(index: number): ChatMessageView {
    return {
        id: `0190a1b2-0000-7000-8000-${String(index).padStart(12, "0")}`,
        channelId: "c1",
        body: `Line ${index}`,
        kind: "text",
        deleted: false,
        forwardable: true,
        starred: false,
        reactions: [],
        attachments: []
    } as unknown as ChatMessageView;
}

const MESSAGES = Array.from({ length: ROWS }, (_, index) => message(index));

function Channel() {
    return (
        <ToastProvider>
            {MESSAGES.map((one, index) => (
                <MessageMenu
                    key={one.id}
                    actions={{
                        message: one,
                        mine: false,
                        canPost: true,
                        canModerate: false,
                        onReply: () => {},
                        onStar: () => {},
                        onDelete: () => {},
                        onReport: () => {},
                        onExplain: () => {},
                        onReact: () => {}
                    }}
                >
                    <div data-testid={`row-${index}`}>{one.body}</div>
                </MessageMenu>
            ))}
        </ToastProvider>
    );
}

describe("the message menu in a long conversation", () => {
    it("builds no row's actions until that row is opened, and then only that row's", async () => {
        const started = performance.now();
        render(<Channel />, { wrapper: MessagesWrapper });
        const mounted = performance.now() - started;
        expect(scheduleRenders).not.toHaveBeenCalled();

        const pressed = performance.now();
        await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByTestId("row-250") });
        const menu = await screen.findByRole("menu");
        const opened = performance.now() - pressed;
        process.stderr.write(`message menu: ${ROWS} rows mounted in ${mounted.toFixed(0)} ms, opened in ${opened.toFixed(0)} ms\n`);

        expect(menu).toBeTruthy();
        expect(scheduleRenders).toHaveBeenCalled();
        // One row's body, however many times React rendered it.
        expect(screen.getAllByRole("menu")).toHaveLength(1);
        expect(screen.getByTestId("row-250").getAttribute("data-state")).toBe("open");
        expect(screen.getByTestId("row-249").getAttribute("data-state")).toBe("closed");
        // Loose on purpose: jsdom on a busy machine, not a browser.
        expect(opened).toBeLessThan(1500);
    });

    it("does not lock the page or hide it from assistive technology", async () => {
        render(<Channel />, { wrapper: MessagesWrapper });
        await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByTestId("row-3") });
        await screen.findByRole("menu");
        expect(document.body.style.pointerEvents).not.toBe("none");
        expect(screen.getByTestId("row-4").closest("[aria-hidden=true]")).toBeNull();
        expect(document.querySelector("[data-scroll-locked]")).toBeNull();
    });

    it("opens with no entrance animation, and keeps the way out", async () => {
        render(<Channel />, { wrapper: MessagesWrapper });
        await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByTestId("row-7") });
        const menu = await screen.findByRole("menu");
        expect(menu.className).not.toMatch(/data-\[state=open\]:animate-in/);
        expect(menu.className).toMatch(/data-\[state=closed\]:animate-out/);
    });

    it("is still walked with the keyboard and closed with Escape", async () => {
        render(<Channel />, { wrapper: MessagesWrapper });
        await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByTestId("row-9") });
        const menu = await screen.findByRole("menu");
        await userEvent.keyboard("{ArrowDown}");
        expect(menu.contains(document.activeElement)).toBe(true);
        await act(async () => {
            fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
        });
        expect(screen.queryByRole("menu")).toBeNull();
    });
});
