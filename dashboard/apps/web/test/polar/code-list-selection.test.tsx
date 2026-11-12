// @vitest-environment jsdom

/**
 * The Code sessions in Polar's list have what a chat's row has: a box to pick
 * several, a bar that removes the picked ones from the history at once, and
 * Share in the row's menu. A running session is never removed, and no row
 * carries a coloured state dot.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { PolarCodeRow } from "@/lib/polar/code";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
    usePathname: () => "/polar",
    useSearchParams: () => new URLSearchParams()
}));
// The share dialog is loaded on demand; here it only has to say what it was opened for.
vi.mock("next/dynamic", () => ({
    default: () =>
        function SharedFor(props: { subject: string; subjectId: string }) {
            return <div data-testid="share-dialog">{`${props.subject}:${props.subjectId}`}</div>;
        }
}));
vi.mock("@/components/polar/polar-sharing", () => ({
    PolarShareDialog: () => null,
    SharedLinksDialog: () => null,
    SharedWithYou: () => null
}));

import { PolarThreads } from "@/components/polar/polar-threads";

afterEach(cleanup);

function session(id: string, live = false): PolarCodeRow {
    return {
        id,
        title: `Task ${id}`,
        repo: "acme/app",
        branch: "main",
        state: live ? "working" : "failed",
        stateLabel: live ? "Working" : "Failed",
        live,
        createdAt: new Date().toISOString()
    };
}

function sidebar() {
    const noop = vi.fn(async () => true);
    return {
        rows: [],
        projects: [],
        hasMore: () => false,
        isLoading: () => false,
        openProjects: new Set<string>(),
        refresh: vi.fn(),
        loadMore: vi.fn(),
        know: vi.fn(),
        retitle: vi.fn(),
        remove: noop,
        bulk: noop,
        toggleProject: vi.fn(),
        openProject: vi.fn(),
        createProject: noop,
        updateProject: noop,
        deleteProject: noop,
        rename: noop,
        setPinned: noop,
        setArchived: noop,
        move: noop
    } as unknown as Parameters<typeof PolarThreads>[0]["sidebar"];
}

function list(rows: PolarCodeRow[]) {
    const remove = vi.fn(async () => true);
    const onOpen = vi.fn();
    render(
        <PolarThreads
            sidebar={sidebar()}
            activeId=""
            onOpen={vi.fn()}
            onNew={vi.fn()}
            hide={{ label: "Hide", icon: () => null, onClick: vi.fn() }}
            code={{
                history: {
                    rows,
                    more: false,
                    loadingMore: false,
                    loadMore: vi.fn(),
                    remove,
                    rename: vi.fn(async () => true)
                },
                activeId: null,
                onOpen,
                canRename: true
            }}
        />,
        { wrapper: MessagesWrapper }
    );
    return { remove, onOpen };
}

describe("Code sessions in Polar's list", () => {
    it("picks several with their boxes and removes the finished ones at once", async () => {
        const { remove } = list([session("a"), session("b"), session("c", true)]);
        fireEvent.click(screen.getByRole("checkbox", { name: 'Select "Task a"' }));
        fireEvent.click(screen.getByRole("checkbox", { name: 'Select "Task b"' }));
        fireEvent.click(screen.getByRole("checkbox", { name: 'Select "Task c"' }));
        expect(screen.getByText("3 selected")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        // The running one is named as staying, and is not removed.
        expect(screen.getByText(/1 still running stays/)).toBeTruthy();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        });
        expect(remove.mock.calls.map(([id]) => id).sort()).toEqual(["a", "b"]);
        expect(screen.queryByText("3 selected")).toBeNull();
    });

    it("cannot remove a selection of running sessions, and says why", () => {
        list([session("c", true)]);
        fireEvent.click(screen.getByRole("checkbox", { name: 'Select "Task c"' }));
        const bar = screen.getByRole("toolbar");
        const button = bar.querySelector("button") as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.getAttribute("title")).toBe("Stop it to delete");
    });

    it("shares a session from its row's menu", () => {
        list([session("a")]);
        const menu = screen.getAllByRole("button", { name: "Conversation options" }).at(-1) as HTMLElement;
        fireEvent.keyDown(menu, { key: "Enter" });
        fireEvent.click(screen.getByRole("menuitem", { name: "Share" }));
        expect(screen.getByTestId("share-dialog").textContent).toBe("agents.session:a");
    });

    it("chooses with Ctrl and Shift presses the way the chats do", () => {
        const { onOpen } = list([session("a"), session("b"), session("c"), session("d")]);
        const open = (id: string) =>
            screen.getByRole("button", { name: `Task ${id}` }) as HTMLButtonElement;
        // A plain press opens and becomes the anchor.
        fireEvent.click(open("a"));
        expect(onOpen).toHaveBeenCalledWith("a");
        fireEvent.click(open("c"), { shiftKey: true });
        expect(screen.getByText("3 selected")).toBeTruthy();
        expect(open("b").getAttribute("aria-pressed")).toBe("true");
        expect(open("d").getAttribute("aria-pressed")).toBe("false");
        fireEvent.click(open("b"), { ctrlKey: true });
        expect(screen.getByText("2 selected")).toBeTruthy();
        expect(onOpen).toHaveBeenCalledTimes(1);
        // The press that stretched also took the focus.
        expect(document.activeElement).toBe(open("b"));
    });

    it("hears its own keys and keeps them from the chats", () => {
        list([session("a"), session("b"), session("c")]);
        const open = (id: string) => screen.getByRole("button", { name: `Task ${id}` });
        open("a").focus();
        fireEvent.keyDown(open("a"), { key: "ArrowDown", shiftKey: true });
        expect(screen.getByText("2 selected")).toBeTruthy();
        expect(document.activeElement).toBe(open("b"));
        fireEvent.keyDown(open("b"), { key: "a", ctrlKey: true });
        expect(screen.getByText("3 selected")).toBeTruthy();
        fireEvent.keyDown(open("b"), { key: "Escape" });
        expect(screen.queryByText(/selected$/)).toBeNull();
    });

    it("lets the selection go on a press on empty list space", () => {
        list([session("a"), session("b")]);
        fireEvent.click(screen.getByRole("checkbox", { name: 'Select "Task a"' }));
        fireEvent.click(screen.getByRole("checkbox", { name: 'Select "Task b"' }));
        // With Ctrl held a press on empty space keeps it.
        fireEvent.mouseDown(screen.getByText("Code sessions"), { ctrlKey: true });
        expect(screen.getByText("2 selected")).toBeTruthy();
        fireEvent.mouseDown(screen.getByText("Code sessions"));
        expect(screen.queryByText("2 selected")).toBeNull();
    });

    it("keeps a Shift press from highlighting text", () => {
        list([session("a")]);
        const row = screen.getByRole("button", { name: "Task a" });
        const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true });
        row.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    });

    it("draws no state dot on a row that is not at work", () => {
        list([session("a")]);
        expect(screen.queryByRole("img", { name: "Failed" })).toBeNull();
    });
});
