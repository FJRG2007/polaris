// @vitest-environment jsdom

/**
 * The item slots every reward editor in the Minecraft panel uses, driven the way
 * an operator drives them: add from the palette by click and by drag, set a count
 * that respects the stack, reorder, remove - and all of it without a mouse.
 */

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

let locale = "en-US";
vi.mock("@polaris/app-host/client", () => ({
    hostUi: { i18nProvider: { useLocale: () => locale } }
}));

const slots = await import("@polaris-app/game-servers/src/screens/installed/item-slots");
const { ItemSlots, moveSlot, placeItem, slotCount } = slots;
type SlotItem = import("@polaris-app/game-servers/src/screens/installed/item-slots").SlotItem;

/** The vanilla catalogue the palette reads. */
const CATALOG = ["diamond", "stone", "ender_pearl", "diamond_sword"];

beforeEach(() => {
    locale = "en-US";
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(CATALOG), { headers: { "content-type": "application/json" } }))
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

/** The editor with its list held the way a reward editor holds it. */
function Harness({ initial, onChange }: { initial: SlotItem[]; onChange?: (next: SlotItem[]) => void }) {
    const [items, setItems] = useState<SlotItem[]>(initial);
    return (
        <ItemSlots
            label="Reward"
            items={items}
            onChange={(next) => {
                setItems(next);
                onChange?.(next);
            }}
        />
    );
}

function lastChange(spy: ReturnType<typeof vi.fn>): SlotItem[] {
    return spy.mock.calls.at(-1)?.[0] as SlotItem[];
}

/** A stand-in for the browser's drag payload, which jsdom does not provide. */
function transfer(): DataTransfer {
    const data = new Map<string, string>();
    return {
        effectAllowed: "all",
        dropEffect: "none",
        setData: (type: string, value: string) => void data.set(type, value),
        getData: (type: string) => data.get(type) ?? ""
    } as unknown as DataTransfer;
}

async function openPalette(): Promise<void> {
    fireEvent.click(screen.getByRole("button", { name: "Add an item" }));
    await screen.findByRole("button", { name: "Diamond" });
}

describe("the pure rules", () => {
    it("moves one slot and shifts the rest", () => {
        expect(moveSlot(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
        expect(moveSlot(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    });

    it("places into a filled slot by replacing it, else after the last, and never past the limit", () => {
        const two = [
            { id: "minecraft:stone", count: 64 },
            { id: "minecraft:diamond", count: 3 }
        ];
        expect(placeItem(two, "minecraft:diamond_sword", 0, 6)?.[0]).toEqual({ id: "minecraft:diamond_sword", count: 1 });
        expect(placeItem(two, "minecraft:ender_pearl", 5, 6)?.[2]).toEqual({ id: "minecraft:ender_pearl", count: 1 });
        expect(placeItem(two, "minecraft:stone", null, 2)).toBeNull();
    });

    it("holds a count to one stack of the item", () => {
        expect(slotCount("minecraft:diamond", "100")).toBe(64);
        expect(slotCount("minecraft:ender_pearl", "40")).toBe(16);
        expect(slotCount("minecraft:diamond_sword", "5")).toBe(1);
        expect(slotCount("minecraft:diamond", "0")).toBe(1);
        expect(Number.isNaN(slotCount("minecraft:diamond", ""))).toBe(true);
    });
});

describe("the item slots", () => {
    it("adds an item from the palette with a click", async () => {
        const changed = vi.fn();
        render(<Harness initial={[]} onChange={changed} />);
        await openPalette();
        fireEvent.click(screen.getByRole("button", { name: "Diamond" }));
        expect(lastChange(changed)).toEqual([{ id: "minecraft:diamond", count: 1 }]);
        expect(screen.getByRole("button", { name: "Slot 1: Diamond, 1" })).toBeTruthy();
    });

    it("adds an item dragged from the palette onto a slot", async () => {
        const changed = vi.fn();
        render(<Harness initial={[{ id: "minecraft:stone", count: 8 }]} onChange={changed} />);
        await openPalette();
        const data = transfer();
        fireEvent.dragStart(screen.getByRole("button", { name: "Ender Pearl" }), { dataTransfer: data });
        const empty = screen.getAllByRole("button", { name: "Empty slot" })[0] as HTMLElement;
        fireEvent.dragOver(empty, { dataTransfer: data });
        fireEvent.drop(empty, { dataTransfer: data });
        expect(lastChange(changed)).toEqual([
            { id: "minecraft:stone", count: 8 },
            { id: "minecraft:ender_pearl", count: 1 }
        ]);
    });

    it("sets the count on the slot, no more than one stack", () => {
        const changed = vi.fn();
        render(
            <Harness
                initial={[
                    { id: "minecraft:ender_pearl", count: 4 },
                    { id: "minecraft:diamond_sword", count: 1 }
                ]}
                onChange={changed}
            />
        );
        fireEvent.click(screen.getByRole("button", { name: "Slot 1: Ender Pearl, 4" }));
        const count = screen.getByRole("spinbutton");
        expect(count.getAttribute("max")).toBe("16");
        fireEvent.change(count, { target: { value: "40" } });
        expect(lastChange(changed)[0]).toEqual({ id: "minecraft:ender_pearl", count: 16 });
        expect(screen.getByText("Up to 16 in one slot, which the player gets as one stack.")).toBeTruthy();
    });

    it("reorders by dragging one slot onto another", () => {
        const changed = vi.fn();
        render(
            <Harness
                initial={[
                    { id: "minecraft:stone", count: 1 },
                    { id: "minecraft:diamond", count: 2 },
                    { id: "minecraft:ender_pearl", count: 3 }
                ]}
                onChange={changed}
            />
        );
        const data = transfer();
        fireEvent.dragStart(screen.getByRole("button", { name: "Slot 1: Stone, 1" }), { dataTransfer: data });
        const target = screen.getByRole("button", { name: "Slot 3: Ender Pearl, 3" });
        fireEvent.dragOver(target, { dataTransfer: data });
        fireEvent.drop(target, { dataTransfer: data });
        expect(lastChange(changed).map((item) => item.id)).toEqual([
            "minecraft:diamond",
            "minecraft:ender_pearl",
            "minecraft:stone"
        ]);
    });

    it("removes a slot dragged out of the row, and keeps one whose drag was cancelled inside it", () => {
        const changed = vi.fn();
        render(
            <Harness
                initial={[
                    { id: "minecraft:stone", count: 1 },
                    { id: "minecraft:diamond", count: 2 }
                ]}
                onChange={changed}
            />
        );
        const row = screen.getByRole("list", { name: "Reward" });
        const stone = screen.getByRole("button", { name: "Slot 1: Stone, 1" });
        const cancelled = transfer();
        fireEvent.dragStart(stone, { dataTransfer: cancelled });
        fireEvent.dragEnd(stone, { dataTransfer: cancelled });
        expect(changed).not.toHaveBeenCalled();

        const data = transfer();
        fireEvent.dragStart(stone, { dataTransfer: data });
        fireEvent.dragLeave(row, { dataTransfer: data, relatedTarget: document.body });
        fireEvent.dragEnd(stone, { dataTransfer: data });
        expect(lastChange(changed)).toEqual([{ id: "minecraft:diamond", count: 2 }]);
    });

    it("does all of it from the keyboard", async () => {
        const changed = vi.fn();
        render(
            <Harness
                initial={[
                    { id: "minecraft:stone", count: 1 },
                    { id: "minecraft:diamond", count: 2 }
                ]}
                onChange={changed}
            />
        );
        // A slot is a button: Enter chooses it and opens its controls.
        fireEvent.click(screen.getByRole("button", { name: "Slot 1: Stone, 1" }));
        fireEvent.click(screen.getByRole("button", { name: "Move later" }));
        expect(lastChange(changed).map((item) => item.id)).toEqual(["minecraft:diamond", "minecraft:stone"]);
        fireEvent.click(screen.getByRole("button", { name: "Move earlier" }));
        expect(lastChange(changed).map((item) => item.id)).toEqual(["minecraft:stone", "minecraft:diamond"]);
        fireEvent.click(screen.getByRole("button", { name: "Remove Stone" }));
        expect(lastChange(changed)).toEqual([{ id: "minecraft:diamond", count: 2 }]);
        // Delete on a focused slot removes it too.
        const diamond = screen.getByRole("button", { name: "Slot 1: Diamond, 2" });
        fireEvent.keyDown(diamond, { key: "Delete" });
        expect(lastChange(changed)).toEqual([]);
        // And adding is a click on an empty slot, then a click in the palette.
        fireEvent.click(screen.getAllByRole("button", { name: "Empty slot" })[0] as HTMLElement);
        fireEvent.click(await screen.findByRole("button", { name: "Stone" }));
        expect(lastChange(changed)).toEqual([{ id: "minecraft:stone", count: 1 }]);
    });

    it("stops offering to add once every slot is taken", () => {
        render(
            <Harness
                initial={Array.from({ length: 6 }, () => ({ id: "minecraft:stone", count: 1 }))}
            />
        );
        expect(screen.getByRole("button", { name: "Add an item" }).hasAttribute("disabled")).toBe(true);
        expect(screen.getByText("All 6 slots are taken. Remove one to add another.")).toBeTruthy();
    });

    it("draws a modded item with no picture as a tile carrying its id", () => {
        render(<Harness initial={[{ id: "securitycraft:keycard_lv1", count: 1 }]} />);
        const slot = screen.getByRole("button", { name: "Slot 1: Keycard Lv1, 1" });
        expect(within(slot).getByText("keycard_lv1")).toBeTruthy();
        expect(slot.getAttribute("title")).toContain("securitycraft:keycard_lv1");
    });

    it("shows a problem the schema found under its slot", () => {
        render(
            <ItemSlots
                label="Reward"
                items={[{ id: "minecraft:stone", count: Number.NaN }]}
                onChange={() => undefined}
                problemAt={(index) => (index === 0 ? "At least 1" : null)}
            />
        );
        expect(screen.getByRole("alert").textContent).toBe("At least 1");
    });

    it("reads in Spanish", async () => {
        locale = "es-ES";
        render(<Harness initial={[{ id: "minecraft:stone", count: 1 }]} />);
        expect(screen.getAllByRole("button", { name: "Hueco vacío" })).toHaveLength(5);
        fireEvent.click(screen.getByRole("button", { name: "Hueco 1: Stone, 1" }));
        expect(screen.getByRole("button", { name: "Mover después" })).toBeTruthy();
        expect(screen.getByText("Cantidad")).toBeTruthy();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Añadir objeto" }));
        });
        await waitFor(() => expect(screen.getByRole("button", { name: "Hecho" })).toBeTruthy());
    });
});
