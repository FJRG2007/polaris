// @vitest-environment jsdom

/**
 * A paged picker opened a second time: the menu is drawn in a portal that
 * mounts after the picker renders, and the list must still follow its scroll -
 * drawing the rows scrolled to and asking for the next page - rather than
 * standing still on whatever it drew before.
 */

import { z } from "zod";
import { PagedPicker } from "@/components/paged-picker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

interface Row {
    readonly id: string;
    readonly name: string;
}

const ROWS: Row[] = Array.from({ length: 120 }, (_, at) => ({
    id: `id-${at}`,
    name: `srv-${String(at).padStart(3, "0")}`
}));

// The same strict input a server's picker action parses.
const input = z
    .object({
        query: z.string().trim().max(120).default(""),
        cursor: z.string().max(2048).nullable().default(null),
        limit: z.number().int().min(1).max(50).default(50),
        ids: z.array(z.string()).min(1).max(50).optional()
    })
    .strict();

function reader() {
    return vi.fn(async (raw: Record<string, unknown>) => {
        const parsed = input.safeParse(raw);
        if (!parsed.success) return { error: "failed" };
        const { query, cursor, limit, ids } = parsed.data;
        const matching = ROWS.filter(
            (row) => (!ids || ids.includes(row.id)) && row.name.includes(query)
        );
        const start = cursor ? Number(cursor) : 0;
        const items = matching.slice(start, start + limit);
        const next = start + limit < matching.length ? String(start + limit) : null;
        return { items, next };
    });
}

const trigger = () => screen.getByRole("button", { name: "Server" });
const open = () => fireEvent.keyDown(trigger(), { key: "ArrowDown" });
const close = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
const scroller = () => {
    const found = document.querySelector<HTMLElement>("[aria-busy]");
    if (!found) throw new Error("no list");
    return found;
};

function scrollTo(top: number): void {
    const element = scroller();
    Object.defineProperty(element, "scrollTop", { configurable: true, value: top });
    fireEvent.scroll(element);
}

let picked = 0;
function Picker({ read }: { read: ReturnType<typeof reader> }) {
    return (
        <PagedPicker<Row>
            read={read}
            scope={{}}
            cache={`reopen-test-${picked}`}
            value={null}
            onValueChange={() => undefined}
            aria-label="Server"
            placeholder="Server"
            searchPlaceholder="Search"
            emptyText="No servers"
        />
    );
}

beforeEach(() => {
    picked += 1;
    // A box taken off the page measures nothing, as it does in a browser.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement
    ) {
        const size = this.isConnected ? { width: 300, height: 288 } : { width: 0, height: 0 };
        return {
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: size.width,
            bottom: size.height,
            ...size,
            toJSON: () => ({})
        };
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("A paged picker opened again", () => {
    it("follows the scroll on the first opening", async () => {
        const read = reader();
        render(<Picker read={read} />);
        open();
        expect(await screen.findByText("srv-000")).toBeTruthy();
        await act(async () => scrollTo(1300));
        expect(await screen.findByText("srv-045")).toBeTruthy();
        expect(read).toHaveBeenCalledWith(expect.objectContaining({ cursor: "50" }));
    });

    it("follows the scroll after it was closed and opened from its cached page", async () => {
        const read = reader();
        render(<Picker read={read} />);
        open();
        expect(await screen.findByText("srv-000")).toBeTruthy();
        close();
        expect(screen.queryByText("srv-000")).toBeNull();

        open();
        expect(await screen.findByText("srv-000")).toBeTruthy();
        await act(async () => scrollTo(1300));
        expect(await screen.findByText("srv-045")).toBeTruthy();
        expect(read).toHaveBeenCalledWith(expect.objectContaining({ cursor: "50" }));
    });

    it("draws rows when it opens again after the closed list was measured", async () => {
        // A browser reports the closed menu's list shrinking to nothing as it leaves.
        const observers: (() => void)[] = [];
        vi.stubGlobal(
            "ResizeObserver",
            class {
                constructor(private readonly changed: (entries: unknown[]) => void) {
                    observers.push(() => this.changed([]));
                }
                observe() {}
                unobserve() {}
                disconnect() {}
            }
        );
        const read = reader();
        render(<Picker read={read} />);
        open();
        expect(await screen.findByText("srv-000")).toBeTruthy();
        close();
        act(() => observers.forEach((changed) => changed()));
        open();
        expect(await screen.findByText("srv-000")).toBeTruthy();
        expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0);
    });
});
