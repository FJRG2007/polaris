// @vitest-environment jsdom

/**
 * The rooms and floors dialog: a floor and a room are made, renamed and
 * removed from it, a removal asks first in the design's own dialog, and a
 * refused change is put back with the reason.
 */

import "@/components/app-host/client";
import { withMessages } from "../../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const calls: { action: string; args: unknown[] }[] = [];
const refuse = { next: "" };
const hold: { floor: Promise<void> | null } = { floor: null };

const ROOMS = [
    { id: "room-1", placeId: "place-1", name: "Kitchen", floor: "Ground floor", floorId: "floor-1" }
];
const FLOORS = [{ id: "floor-1", placeId: "place-1", name: "Ground floor" }];

function answer<T>(value: T): T | { error: string } {
    if (!refuse.next) return value;
    const error = refuse.next;
    refuse.next = "";
    return { error };
}

vi.mock("@polaris-app/places/src/screens/actions", () => ({
    listRoomsAction: async () => ({ rooms: ROOMS }),
    listFloorsAction: async () => ({ floors: FLOORS }),
    placeUsesAction: async () => ({ uses: { "floor-1": 2 } }),
    saveFloorAction: async (...args: unknown[]) => {
        calls.push({ action: "floor", args });
        if (hold.floor) await hold.floor;
        const input = args[1] as { name: string };
        return answer({ floor: { id: "floor-2", placeId: "place-1", name: input.name } });
    },
    deleteFloorAction: async (...args: unknown[]) => {
        calls.push({ action: "deleteFloor", args });
        return answer({});
    },
    saveRoomAction: async (...args: unknown[]) => {
        calls.push({ action: "room", args });
        const input = args[1] as { name: string; floor: string; floorId: string };
        return answer({ room: { id: "room-2", placeId: "place-1", ...input } });
    },
    deleteRoomAction: async (...args: unknown[]) => {
        calls.push({ action: "deleteRoom", args });
        return answer({});
    }
}));

const { RoomsDialog } = await import("@polaris-app/places/src/screens/devices/rooms-dialog");

async function painted(): Promise<void> {
    await act(async () => {
        for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
}

async function opened(): Promise<void> {
    render(withMessages(<RoomsDialog open placeId="place-1" onClose={() => {}} />));
    await painted();
}

beforeEach(() => {
    calls.length = 0;
    refuse.next = "";
    hold.floor = null;
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("the rooms and floors dialog", () => {
    it("adds a floor and a room on it", async () => {
        await opened();
        fireEvent.change(screen.getByLabelText("New floor"), { target: { value: " Attic " } });
        fireEvent.click(screen.getByRole("button", { name: "Add a floor" }));
        await painted();
        expect(calls[0]).toEqual({ action: "floor", args: [null, { placeId: "place-1", name: "Attic" }] });
        expect(screen.getAllByLabelText("Name of the floor").map((input) => (input as HTMLInputElement).value)).toEqual([
            "Attic",
            "Ground floor"
        ]);
        fireEvent.change(screen.getByLabelText("New room"), { target: { value: "Hall" } });
        fireEvent.click(screen.getByRole("button", { name: "Add room" }));
        await painted();
        expect(calls[1]?.action).toBe("room");
        expect(calls[1]?.args[0]).toBeNull();
        expect(calls[1]?.args[1]).toMatchObject({ placeId: "place-1", name: "Hall", floorId: "" });
    });

    it("renames a room only once its name differs", async () => {
        await opened();
        const save = screen.getByRole("button", { name: "Save Kitchen" });
        expect(save).toHaveProperty("disabled", true);
        fireEvent.change(screen.getByDisplayValue("Kitchen"), { target: { value: "Pantry" } });
        fireEvent.click(screen.getByRole("button", { name: "Save Kitchen" }));
        await painted();
        expect(calls[0]?.args[0]).toBe("room-1");
        expect(calls[0]?.args[1]).toMatchObject({ name: "Pantry", floorId: "floor-1" });
    });

    it("asks before removing a floor, in its own dialog", async () => {
        await opened();
        fireEvent.click(screen.getByRole("button", { name: "Remove Ground floor" }));
        await painted();
        expect(calls).toHaveLength(0);
        const confirm = screen.getByRole("dialog", { name: "Remove floor" });
        fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
        await painted();
        expect(calls[0]).toEqual({ action: "deleteFloor", args: ["floor-1"] });
        expect(screen.queryAllByLabelText("Name of the floor")).toHaveLength(0);
    });

    it("says how many automations stop acting on a floor before removing it", async () => {
        await opened();
        fireEvent.click(screen.getByRole("button", { name: "Remove Ground floor" }));
        await painted();
        const confirm = screen.getByRole("dialog", { name: "Remove floor" });
        expect(confirm.textContent).toContain("2 automations name it and will stop acting on it.");
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await painted();
        fireEvent.click(screen.getByRole("button", { name: "Remove Kitchen" }));
        await painted();
        expect(screen.getByRole("dialog", { name: "Remove room" }).textContent).not.toContain("automation");
    });

    it("leaves a floor still being made alone until the server answers", async () => {
        let release = () => {};
        hold.floor = new Promise<void>((resolve) => {
            release = resolve;
        });
        await opened();
        fireEvent.change(screen.getByLabelText("New floor"), { target: { value: "Attic" } });
        fireEvent.click(screen.getByRole("button", { name: "Add a floor" }));
        await painted();
        expect(screen.getByRole("button", { name: "Remove Attic" })).toHaveProperty("disabled", true);
        expect(screen.getByDisplayValue("Attic")).toHaveProperty("disabled", true);
        await act(async () => release());
        await painted();
        expect(screen.getByRole("button", { name: "Remove Attic" })).toHaveProperty("disabled", false);
    });

    it("puts a refused removal back and says why", async () => {
        await opened();
        refuse.next = "Room not found";
        fireEvent.click(screen.getByRole("button", { name: "Remove Kitchen" }));
        await painted();
        const confirm = screen.getByRole("dialog", { name: "Remove room" });
        fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
        await painted();
        expect(screen.getByDisplayValue("Kitchen")).toBeTruthy();
        expect(screen.getByRole("alert").textContent).toBe("Room not found");
    });
});
