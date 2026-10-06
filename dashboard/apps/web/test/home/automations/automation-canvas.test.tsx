// @vitest-environment jsdom

/**
 * The automation editor's visual layout as somebody uses it.
 *
 * The diagram edits the same draft as the form: an automation opened in it and
 * left alone has nothing to save, a node opens the form's own card with the
 * form's own checks, the palette adds what the schema has, and what is saved is
 * what the form would have saved. On a narrow screen the same nodes are a list.
 */

import "@/components/app-host/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AutomationView } from "@polaris-app/places/src/lib/automation-kinds";

const saved: unknown[] = [];
let wide = true;

vi.mock("next/navigation", async (original) => ({
    ...(await original<typeof import("next/navigation")>()),
    useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() })
}));

function device(id: string, kind: string, extra: Partial<DeviceView> = {}): DeviceView {
    return {
        id,
        vendor: "fixture",
        kind,
        name: `Fixture ${id}`,
        zone: "",
        placeId: "place-1",
        model: "",
        firmware: "",
        state: "off",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: null,
        stateAt: null,
        ...extra
    };
}

const DEVICES = [
    device("plug", "outlet"),
    device("door", "lock", { state: "locked", doorState: "closed" })
];

/** Saved by the form: a trigger, two groups of conditions, three steps. */
const SAVED: AutomationView = {
    id: "auto-1",
    placeId: "place-1",
    name: "Fixture automation with a name long enough to need more than one line somewhere",
    enabled: true,
    ownerName: "Fixture owner",
    definition: {
        timeZone: "UTC",
        triggers: [
            {
                id: "trig01",
                kind: "stays",
                deviceId: "plug",
                attribute: "state",
                is: "on",
                minutes: 30
            }
        ],
        conditions: {
            match: "any",
            groups: [
                {
                    id: "grp001",
                    match: "all",
                    items: [
                        { id: "cond01", kind: "time", from: "22:00", to: "07:00" },
                        { id: "cond02", kind: "weekday", days: [0, 6] }
                    ]
                },
                {
                    id: "grp002",
                    match: "all",
                    items: [
                        {
                            id: "cond03",
                            kind: "device",
                            deviceId: "door",
                            attribute: "state",
                            is: "locked",
                            negate: false
                        }
                    ]
                }
            ]
        },
        actions: [
            { id: "step01", kind: "device", deviceId: "plug", do: "turn-off" },
            { id: "step02", kind: "delay", seconds: 60 },
            { id: "step03", kind: "notify", message: "The plug was switched off" }
        ]
    },
    lastRunAt: null,
    lastStatus: null,
    updatedAt: "2026-09-30T06:00:00.000Z"
};

vi.mock("@polaris-app/places/src/screens/automations/actions", () => ({
    getAutomationAction: async (id: string | null) => ({
        automation: id ? SAVED : undefined,
        runs: [],
        context: {
            placeId: "place-1",
            devices: DEVICES,
            siblings: [{ id: "auto-1", name: SAVED.name }]
        }
    }),
    saveAutomationAction: async (_id: string | null, input: unknown) => {
        saved.push(input);
        const value = input as Pick<AutomationView, "name" | "enabled" | "placeId" | "definition">;
        return { automation: { ...SAVED, ...value } };
    },
    automationRunsAction: async () => ({ runs: [] }),
    runAutomationAction: async () => ({})
}));

const { AutomationEditor } = await import(
    "@polaris-app/places/src/screens/automations/automation-editor"
);

class Observer {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
}

async function painted(): Promise<void> {
    await act(async () => {
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

async function openVisual(automationId: string | null, canManage = true): Promise<void> {
    render(
        <AutomationEditor
            automationId={automationId}
            template={null}
            deviceId={null}
            canManage={canManage}
            canControl
            initialTab="flow"
        />
    );
    await painted();
    fireEvent.click(screen.getByRole("radio", { name: "Visual" }));
    await painted();
}

/** A design-system menu opens on the pointer going down, as Radix menus do. */
function openMenu(name: string): void {
    fireEvent.pointerDown(screen.getByRole("button", { name }), { button: 0, ctrlKey: false });
}

async function pick(menu: string, item: string): Promise<void> {
    openMenu(menu);
    fireEvent.click(await screen.findByRole("menuitem", { name: item }));
    await painted();
}

/** A key pressed and let go, as a hand does: the diagram tracks which keys are
 *  down, and one never released is still held. */
function press(element: HTMLElement, key: string): void {
    fireEvent.keyDown(element, { key, code: key });
    fireEvent.keyUp(element, { key, code: key });
}

function node(id: string): HTMLElement {
    const found = document.querySelector<HTMLElement>(`[data-flow-node][data-id="${id}"]`);
    if (!found) throw new Error(`no node ${id} drawn`);
    return found;
}

/** A node clicked as a hand does: a click on it also gives it the focus, which
 *  this environment's click alone does not. */
function choose(id: string): void {
    node(id).focus();
    fireEvent.click(node(id));
}

/** This environment's own storage is the runtime's, which warns and keeps
 *  nothing; a page's is a map that lives as long as the test. */
function memoryStorage(): Storage {
    const items = new Map<string, string>();
    return {
        get length() {
            return items.size;
        },
        clear: () => items.clear(),
        getItem: (key) => items.get(key) ?? null,
        key: (index) => [...items.keys()][index] ?? null,
        removeItem: (key) => void items.delete(key),
        setItem: (key, value) => void items.set(key, String(value))
    };
}

beforeEach(() => {
    saved.length = 0;
    wide = true;
    Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
    vi.stubGlobal("ResizeObserver", Observer);
    vi.stubGlobal("matchMedia", (query: string) => ({
        matches: wide,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false
    }));
    try {
        sessionStorage.clear();
    } catch {
        // No storage in this environment is the same as an empty one.
    }
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("an automation saved by the form, opened as a diagram", () => {
    it("draws every node, and has nothing to save until something changes", async () => {
        await openVisual("auto-1");
        expect(screen.getByRole("region", { name: "Automation diagram" })).toBeDefined();
        for (const id of ["trig01", "$gate", "grp001", "cond01", "cond02", "grp002", "cond03"])
            expect(node(id)).toBeDefined();
        for (const id of ["step01", "step02", "step03"]) expect(node(id)).toBeDefined();
        expect(node("step03").getAttribute("aria-label")).toBe(
            "Notify me. Notify: The plug was switched off"
        );
        expect(node("$gate").getAttribute("aria-label")).toBe("If. Any group holds");
        expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe(
            "true"
        );
    });

    it("remembers the layout for the next automation opened", async () => {
        await openVisual("auto-1");
        cleanup();
        render(
            <AutomationEditor
                automationId="auto-1"
                template={null}
                deviceId={null}
                canManage
                canControl
                initialTab="flow"
            />
        );
        await painted();
        expect(screen.getByRole("radio", { name: "Visual" }).getAttribute("aria-checked")).toBe(
            "true"
        );
        expect(screen.getByRole("region", { name: "Automation diagram" })).toBeDefined();
    });

    it("opens the form's own card for a node, and saves only what was changed", async () => {
        await openVisual("auto-1");
        expect(screen.getByText("Select a node to change it.")).toBeDefined();
        fireEvent.click(node("trig01"));
        await painted();
        const minutes = screen.getByLabelText(/^For/) as HTMLInputElement;
        expect(minutes.value).toBe("30");
        fireEvent.change(minutes, { target: { value: "45" } });
        await painted();
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await painted();

        expect(saved).toHaveLength(1);
        const input = saved[0] as { definition: AutomationView["definition"] };
        expect(input.definition).toEqual({
            ...SAVED.definition,
            triggers: [{ ...SAVED.definition.triggers[0], minutes: 45 }]
        });
    });

    it("marks a node with a wrong value as soon as it is typed, and holds Save", async () => {
        await openVisual("auto-1");
        fireEvent.click(node("trig01"));
        await painted();
        fireEvent.change(screen.getByLabelText(/^For/), { target: { value: "0" } });
        await painted();
        expect(screen.getByText("That is too small.")).toBeDefined();
        expect(node("trig01").getAttribute("aria-label")).toContain("Needs a fix.");
        expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe(
            "true"
        );
    });

    it("moves a selected step one place with the arrow keys, and removes it with Delete", async () => {
        await openVisual("auto-1");
        fireEvent.click(node("step03"));
        await painted();
        press(node("step03"), "ArrowUp");
        await painted();
        press(node("trig01"), "ArrowLeft");
        await painted();
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await painted();
        const moved = saved[0] as { definition: AutomationView["definition"] };
        expect(moved.definition.actions.map((step) => step.id)).toEqual([
            "step01",
            "step03",
            "step02"
        ]);
        expect(moved.definition.triggers).toEqual(SAVED.definition.triggers);

        choose("step02");
        await painted();
        press(node("step02"), "Delete");
        await painted();
        expect(document.querySelector('[data-flow-node][data-id="step02"]')).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await painted();
        const removed = saved[1] as { definition: AutomationView["definition"] };
        expect(removed.definition.actions.map((step) => step.id)).toEqual(["step01", "step03"]);
    });

    it("leaves the selected node alone when Delete is pressed outside the diagram", async () => {
        await openVisual("auto-1");
        choose("step02");
        await painted();
        const close = screen.getByRole("button", { name: "Close" });
        act(() => close.focus());
        await painted();
        press(close, "Delete");
        press(close, "Backspace");
        await painted();
        expect(node("step02")).toBeDefined();
        expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe(
            "true"
        );
    });

    it("never removes the gate", async () => {
        await openVisual("auto-1");
        choose("$gate");
        await painted();
        expect(screen.getByText("It only goes on if these hold.")).toBeDefined();
        press(node("$gate"), "Delete");
        await painted();
        expect(node("$gate")).toBeDefined();
        expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe(
            "true"
        );
    });

    it("opens a condition's group, with how its conditions combine", async () => {
        await openVisual("auto-1");
        fireEvent.click(node("cond02"));
        await painted();
        expect(screen.getByRole("combobox", { name: "How these combine" })).toBeDefined();
        expect(screen.getByRole("button", { name: "Remove group" })).toBeDefined();
    });
});

describe("the palette", () => {
    it("adds a step, opens it, and says what it still needs only when Save is pressed", async () => {
        await openVisual(null);
        expect(screen.queryByText("Add at least one trigger.")).toBeNull();
        await pick("Add trigger", "Only by hand");
        await pick("Add step", "Notify me");
        const message = screen.getByLabelText(/^Message/) as HTMLInputElement;
        expect(message.value).toBe("");
        fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Fixture" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await painted();
        expect(screen.getByText("Write the message.")).toBeDefined();
        expect(saved).toEqual([]);

        fireEvent.change(message, { target: { value: "Fixture message" } });
        await painted();
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await painted();
        const input = saved[0] as { definition: AutomationView["definition"] };
        expect(input.definition.triggers).toEqual([expect.objectContaining({ kind: "manual" })]);
        expect(input.definition.actions).toEqual([
            expect.objectContaining({ kind: "notify", message: "Fixture message" })
        ]);
    });

    it("offers every kind the schema has", async () => {
        await openVisual("auto-1");
        openMenu("Add trigger");
        expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
            "A device changes",
            "A device stays",
            "A reading crosses",
            "At a time",
            "Every so often",
            "Only by hand"
        ]);
        fireEvent.keyDown(screen.getAllByRole("menuitem")[0]!, { key: "Escape" });
        await painted();
        openMenu("Add step");
        expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
            "Operate a device",
            "Wait a while",
            "Wait for a device",
            "Notify me",
            "Run an automation"
        ]);
    });

    it("puts a condition into the selected group, and starts a group otherwise", async () => {
        await openVisual("auto-1");
        fireEvent.click(node("cond03"));
        await painted();
        expect(screen.getByText("Conditions go into the selected group.")).toBeDefined();
        await pick("Add condition", "On days");
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        await painted();
        expect(
            screen.getByText("Each condition starts a new group. Select a group to add to it.")
        ).toBeDefined();
        await pick("Add condition", "Between times");
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await painted();
        const input = saved[0] as { definition: AutomationView["definition"] };
        const groups = input.definition.conditions.groups;
        expect(groups).toHaveLength(3);
        expect(groups[1]!.items.map((item) => item.kind)).toEqual(["device", "weekday"]);
        expect(groups[2]!.items.map((item) => item.kind)).toEqual(["time"]);
    });

    it("is not offered to somebody who can only read", async () => {
        await openVisual("auto-1", false);
        expect(screen.getByRole("region", { name: "Automation diagram" })).toBeDefined();
        expect(screen.queryByRole("button", { name: "Add step" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Add trigger" })).toBeNull();
    });
});

describe("the diagram on a narrow screen", () => {
    it("is the same nodes as a list, each opening its card under it", async () => {
        wide = false;
        await openVisual("auto-1");
        expect(screen.queryByRole("region", { name: "Automation diagram" })).toBeNull();
        expect(screen.getByRole("heading", { name: "When" })).toBeDefined();
        expect(screen.getByRole("heading", { name: "Then" })).toBeDefined();
        const step = screen.getByRole("button", { name: "Wait a while. Wait 1 minute" });
        expect(step.getAttribute("aria-expanded")).toBe("false");
        fireEvent.click(step);
        await painted();
        expect(step.getAttribute("aria-expanded")).toBe("true");
        expect(screen.getByRole("combobox", { name: "Kind of step" })).toBeDefined();
        fireEvent.click(step);
        await painted();
        expect(screen.queryByRole("combobox", { name: "Kind of step" })).toBeNull();
    });
});
