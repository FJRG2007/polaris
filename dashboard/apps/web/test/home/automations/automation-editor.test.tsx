// @vitest-environment jsdom

/**
 * The automation screens as somebody uses them.
 *
 * The editor is a column of cards - WHEN, IF, THEN - checked against the same
 * schema the server runs, as it is typed. What is merely not filled in yet waits
 * for a press of Save before it is called out; what is wrong is said at once,
 * under its own field. The list's switch moves when pressed and moves back, with
 * the reason, when the server says no.
 */

import "@/components/app-host/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AutomationView, RunView } from "@polaris-app/places/src/lib/automation-kinds";
import * as auto from "@polaris-app/places/src/lib/automation-kinds";

const replaced: string[] = [];
const pushed: string[] = [];
const saved: unknown[] = [];
let toggleAnswer: { error?: string; automation?: AutomationView } = {};

vi.mock("next/navigation", async (original) => ({
    ...(await original<typeof import("next/navigation")>()),
    useRouter: () => ({
        replace: (href: string) => replaced.push(href),
        push: (href: string) => pushed.push(href),
        refresh: vi.fn()
    })
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
    device("door", "lock", { state: "locked", doorState: "closed" }),
    device("ac", "climate", {
        state: "on",
        reading: { value: "24", unit: "\u00b0C" },
        climate: {
            mode: "cool",
            modes: ["cool", "heat"],
            target: 24,
            min: 16,
            max: 30,
            step: 1,
            unit: "C",
            fan: "auto",
            fans: ["auto", "high"],
            options: {},
            current: 24
        }
    }),
    device("air", "air", {
        state: "on",
        reading: { value: "12", unit: "µg/m³" },
        air: {
            mode: "auto",
            modes: ["auto", "sleep"],
            speed: null,
            speeds: ["speed_1", "speed_2"],
            humidity: { target: 50, min: 40, max: 70, step: 10 },
            options: { childLock: false },
            readings: { pm25: 12, humidity: 45 },
            filters: []
        }
    })
];

const SAVED: AutomationView = {
    id: "auto-1",
    placeId: "place-1",
    name: "Fixture automation",
    enabled: true,
    ownerName: "Fixture owner",
    definition: {
        timeZone: "UTC",
        triggers: [{ id: "trig01", kind: "manual" }],
        conditions: { match: "all", groups: [] },
        actions: [{ id: "step01", kind: "device", deviceId: "plug", do: "turn-off" }]
    },
    lastRunAt: "2026-09-30T07:00:00.000Z",
    lastStatus: "failed",
    updatedAt: "2026-09-30T06:00:00.000Z"
};

/** An evening that warms the bedroom: a step that sets a temperature. */
const CLIMATE_SAVED: AutomationView = {
    ...SAVED,
    id: "auto-climate",
    name: "Warm the bedroom",
    definition: {
        ...SAVED.definition,
        actions: [
            {
                id: "step01",
                kind: "device",
                deviceId: "ac",
                do: "set-temperature",
                setting: { action: "set-temperature", target: 22 }
            }
        ]
    }
};

/** A purifier that goes to its second speed when the dust rises. */
const AIR_SAVED: AutomationView = {
    ...SAVED,
    id: "auto-air",
    name: "Clean the air",
    definition: {
        ...SAVED.definition,
        triggers: [
            {
                id: "trig01",
                kind: "threshold",
                deviceId: "air",
                direction: "above",
                value: 35,
                measure: "pm25"
            }
        ],
        actions: [
            {
                id: "step01",
                kind: "device",
                deviceId: "air",
                do: "set-fan",
                setting: { action: "set-fan", speed: "speed_2" }
            }
        ]
    }
};

const RUNS: RunView[] = [
    {
        id: "run-1",
        automationId: "auto-1",
        status: "failed",
        cause: { kind: "manual", byUser: "Fixture owner", at: "2026-09-30T07:00:00.000Z" },
        steps: [
            {
                stepId: "step01",
                kind: "device",
                outcome: "failed",
                said: "Fixture plug was not answering when it was last checked",
                at: "2026-09-30T07:00:01.000Z"
            }
        ],
        reason: "step",
        startedAt: "2026-09-30T07:00:00.000Z",
        finishedAt: "2026-09-30T07:00:01.000Z",
        dueAt: null
    }
];

vi.mock("@polaris-app/places/src/screens/automations/actions", () => ({
    getAutomationAction: async (id: string | null) => ({
        automation:
            id === "auto-climate"
                ? CLIMATE_SAVED
                : id === "auto-air"
                  ? AIR_SAVED
                  : id
                    ? SAVED
                    : undefined,
        runs: id ? RUNS : [],
        context: {
            placeId: "place-1",
            devices: DEVICES,
            siblings: [{ id: "auto-1", name: "Fixture automation" }]
        }
    }),
    saveAutomationAction: async (_id: string | null, input: unknown) => {
        saved.push(input);
        const value = input as Pick<AutomationView, "name" | "enabled" | "placeId" | "definition">;
        return { automation: { ...SAVED, ...value, id: "auto-2" } };
    },
    automationRunsAction: async () => ({ runs: RUNS }),
    runAutomationAction: async () => ({}),
    listAutomationsAction: async () => ({
        automations: [SAVED],
        devices: DEVICES,
        placeId: "place-1"
    }),
    setAutomationEnabledAction: async () => toggleAnswer,
    deleteAutomationAction: async () => ({}),
    addAutoOffAction: async () => ({})
}));

const { AutomationEditor } =
    await import("@polaris-app/places/src/screens/automations/automation-editor");
const { AutomationsView } =
    await import("@polaris-app/places/src/screens/automations/automations-view");

async function painted(): Promise<void> {
    await act(async () => {
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });
}

/** The rows of one stage's list: each row is the button that selects it. */
function rowsIn(list: string): HTMLElement[] {
    const found = screen.queryByRole("list", { name: list });
    if (!found) return [];
    return within(found)
        .queryAllByRole("button")
        .filter((button) => button.hasAttribute("aria-pressed"));
}

function rowCount(list: string): number {
    return rowsIn(list).length;
}

/** Selects a block by its row, which opens its fields in the panel. */
function openRow(list: string, at = 0): void {
    fireEvent.click(rowsIn(list)[at]!);
}

function openMenu(name: string): void {
    fireEvent.pointerDown(screen.getByRole("button", { name }), { button: 0, ctrlKey: false });
}

beforeEach(() => {
    replaced.length = 0;
    pushed.length = 0;
    saved.length = 0;
    toggleAnswer = {};
    try {
        sessionStorage.clear();
    } catch {
        // No storage in this environment is the same as an empty one.
    }
});

afterEach(() => cleanup());

describe("a new automation from the switch-off template", () => {
    it("is laid out as when, if and then, ready to save", async () => {
        render(
            <AutomationEditor
                automationId={null}
                template="autoOff"
                deviceId="plug"
                canManage
                canControl
                initialTab="flow"
            />
        );
        await painted();
        expect(screen.getByRole("heading", { name: "When" })).toBeDefined();
        expect(screen.getByRole("heading", { name: "If" })).toBeDefined();
        expect(screen.getByRole("heading", { name: "Then" })).toBeDefined();
        expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe(
            "Turn off Fixture plug after 30 minutes"
        );

        const save = screen.getByRole("button", { name: "Save" });
        expect(save.getAttribute("aria-disabled")).toBeNull();
        fireEvent.click(save);
        await painted();

        expect(saved).toHaveLength(1);
        const input = saved[0] as { definition: { triggers: unknown[]; actions: unknown[] } };
        expect(input.definition.triggers).toEqual([
            expect.objectContaining({
                kind: "stays",
                deviceId: "plug",
                attribute: "state",
                is: "on",
                minutes: 30
            })
        ]);
        expect(input.definition.actions).toEqual([
            expect.objectContaining({ kind: "device", deviceId: "plug", do: "turn-off" })
        ]);
        expect(replaced).toEqual(["/places/devices/automations/auto-2"]);
    });

    it("says a wrong number under its field as it is typed", async () => {
        render(
            <AutomationEditor
                automationId={null}
                template="autoOff"
                deviceId="plug"
                canManage
                canControl
                initialTab="flow"
            />
        );
        await painted();
        openRow("When");
        fireEvent.change(screen.getByLabelText(/^For/), { target: { value: "0" } });
        expect(
            screen.getByText(
                'At least 1 minute. To act the moment it happens, use "A device changes".'
            )
        ).toBeDefined();
        expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe(
            "true"
        );
    });
});

describe("an empty automation", () => {
    it("marks what is missing, and names it only when Save is pressed", async () => {
        render(
            <AutomationEditor
                automationId={null}
                template={null}
                deviceId={null}
                canManage
                canControl
                initialTab="flow"
            />
        );
        await painted();
        expect(screen.queryByText("Give it a name.")).toBeNull();
        const save = screen.getByRole("button", { name: "Save" });
        expect(save.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(save);
        await painted();
        expect(screen.getByText("Give it a name.")).toBeDefined();
        expect(screen.getByText("Add at least one trigger.")).toBeDefined();
        expect(screen.getByText("Add at least one step.")).toBeDefined();
        expect(saved).toEqual([]);
    });

    it("adds steps, moves them and removes them", async () => {
        render(
            <AutomationEditor
                automationId={null}
                template={null}
                deviceId={null}
                canManage
                canControl
                initialTab="flow"
            />
        );
        await painted();
        openMenu("Add step");
        fireEvent.click(await screen.findByRole("menuitem", { name: "Wait a while" }));
        openMenu("Add step");
        fireEvent.click(await screen.findByRole("menuitem", { name: "Notify me" }));
        expect(screen.getByLabelText(/Message/)).toBeDefined();

        const moves = screen.getAllByRole("button", { name: "Move up" });
        fireEvent.click(moves[moves.length - 1]!);
        // The message is now the first step, so its card carries the number 1.
        const first = screen.getByLabelText(/Message/).closest("aside") as HTMLElement;
        expect(within(first).getByText("1")).toBeDefined();

        const removes = screen.getAllByRole("button", { name: "Remove" });
        fireEvent.click(removes[0]!);
        expect(screen.queryByLabelText(/Message/)).toBeNull();
    });

    it("offers no device to a step when the reader cannot operate them", async () => {
        render(
            <AutomationEditor
                automationId={null}
                template={null}
                deviceId={null}
                canManage
                canControl={false}
                initialTab="flow"
            />
        );
        await painted();
        openMenu("Add step");
        fireEvent.click(await screen.findByRole("menuitem", { name: "Operate a device" }));
        expect(
            screen.getByText("You cannot operate devices, so a step cannot use them.")
        ).toBeDefined();
    });
});

describe("the log of a saved automation", () => {
    it("says what happened in words, the device's refusal included", async () => {
        render(
            <AutomationEditor
                automationId="auto-1"
                template={null}
                deviceId={null}
                canManage
                canControl
                initialTab="runs"
            />
        );
        await painted();
        expect(screen.getByText("Run by Fixture owner")).toBeDefined();
        fireEvent.click(screen.getByRole("button", { name: /Run by Fixture owner/ }));
        expect(screen.getByText("Stopped at the step that failed.")).toBeDefined();
        expect(
            screen.getByText("Fixture plug was not answering when it was last checked")
        ).toBeDefined();
    });
});

describe("the list", () => {
    it("moves the switch at once and puts it back, with the reason, when refused", async () => {
        toggleAnswer = { error: "You do not have access to that" };
        render(<AutomationsView placeId="place-1" canManage />);
        await painted();
        const toggle = screen.getByRole("switch", { name: "Switch off Fixture automation" });
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        fireEvent.click(toggle);
        await painted();
        expect(
            screen
                .getByRole("switch", { name: "Switch off Fixture automation" })
                .getAttribute("aria-checked")
        ).toBe("true");
        expect(screen.getByRole("alert").textContent).toBe("You do not have access to that");
    });

    it("keeps the switch where it was put when the server agrees", async () => {
        toggleAnswer = { automation: { ...SAVED, enabled: false } };
        render(<AutomationsView placeId="place-1" canManage />);
        await painted();
        fireEvent.click(screen.getByRole("switch", { name: "Switch off Fixture automation" }));
        await painted();
        expect(
            screen
                .getByRole("switch", { name: "Switch on Fixture automation" })
                .getAttribute("aria-checked")
        ).toBe("false");
    });
});

describe("a step that sets an air conditioner", () => {
    it("shows what it sets, and refuses at once a value the unit does not accept", async () => {
        render(
            <AutomationEditor
                automationId="auto-climate"
                template={null}
                deviceId={null}
                canManage
                canControl
                initialTab="flow"
            />
        );
        await painted();
        openRow("Then");
        const target = screen.getByLabelText(/^Temperature/) as HTMLInputElement;
        expect(target.value).toBe("22");
        fireEvent.change(target, { target: { value: "35" } });
        expect(screen.getByText("Choose a value this device accepts.")).toBeDefined();
        expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe(
            "true"
        );
        fireEvent.change(target, { target: { value: "21" } });
        expect(screen.queryByText("Choose a value this device accepts.")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await painted();
        const input = saved[0] as { definition: { actions: unknown[] } };
        expect(input.definition.actions).toEqual([
            expect.objectContaining({
                kind: "device",
                deviceId: "ac",
                do: "set-temperature",
                setting: { action: "set-temperature", target: 21 }
            })
        ]);
    });
});

describe("an automation on an air purifier", () => {
    it("compares the figure it names, and sets a speed the unit has", async () => {
        render(
            <AutomationEditor
                automationId="auto-air"
                template={null}
                deviceId={null}
                canManage
                canControl
                initialTab="flow"
            />
        );
        await painted();
        openRow("When");
        expect(screen.getByRole("combobox", { name: /^Reading/ }).textContent).toContain("PM2.5");
        expect(screen.getByText("µg/m³")).toBeDefined();
        const value = screen.getByLabelText(/^Value/) as HTMLInputElement;
        fireEvent.change(value, { target: { value: "50" } });
        openRow("Then");
        expect(screen.getByRole("combobox", { name: /^Fan speed/ }).textContent).toContain(
            "Speed 2"
        );
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await painted();
        const input = saved[0] as { definition: { triggers: unknown[]; actions: unknown[] } };
        expect(input.definition.triggers).toEqual([
            expect.objectContaining({
                kind: "threshold",
                deviceId: "air",
                value: 50,
                measure: "pm25"
            })
        ]);
        expect(input.definition.actions).toEqual([
            expect.objectContaining({
                do: "set-fan",
                setting: { action: "set-fan", speed: "speed_2" }
            })
        ]);
    });
});

describe("the block editor", () => {
    const editor = (id: string | null, template: string | null = null) => (
        <AutomationEditor
            automationId={id}
            template={template}
            deviceId={template ? "plug" : null}
            canManage
            canControl
            initialTab="flow"
        />
    );
    const inputOf = (view: AutomationView) => ({
        name: view.name,
        enabled: view.enabled,
        placeId: view.placeId,
        definition: view.definition
    });

    it("loads and saves an automation exactly as it was stored, names and notes included", () => {
        const named = {
            ...inputOf(SAVED),
            definition: {
                ...SAVED.definition,
                triggers: SAVED.definition.triggers.map((trigger, index) =>
                    index === 0 ? { ...trigger, alias: "Porch", note: "Only at night" } : trigger
                ),
                actions: SAVED.definition.actions.map((step) => ({ ...step, note: "Step note" }))
            }
        };
        for (const input of [inputOf(SAVED), inputOf(CLIMATE_SAVED), inputOf(AIR_SAVED), named])
            expect(auto.automationInputSchema.parse(auto.normalizeAutomationInput(input))).toEqual(
                input
            );
    });

    it("opens a stored automation with nothing to save", async () => {
        render(editor("auto-1"));
        await painted();
        expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe(
            "true"
        );
        expect(screen.getByRole("button", { name: "Undo change" }).hasAttribute("disabled")).toBe(
            true
        );
    });

    it("renames a block from its menu and saves the name with it", async () => {
        render(editor(null, "autoOff"));
        await painted();
        const menu = within(screen.getByRole("list", { name: "When" })).getAllByRole("button", {
            name: /^More actions/
        })[0]!;
        fireEvent.pointerDown(menu, { button: 0, ctrlKey: false });
        fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.change(within(dialog).getByLabelText("Name shown instead of the sentence"), {
            target: { value: "Porch" }
        });
        fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
        await painted();
        expect(rowsIn("When")[0]!.textContent).toContain("Porch");
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await painted();
        const input = saved[0] as { definition: { triggers: { alias?: string }[] } };
        expect(input.definition.triggers[0]?.alias).toBe("Porch");
    });

    it("copies and pastes the selected block, and undoes and redoes with the keyboard", async () => {
        render(editor(null, "autoOff"));
        await painted();
        const before = rowCount("Then");
        openRow("Then");
        fireEvent.keyDown(window, { key: "c", ctrlKey: true });
        fireEvent.keyDown(window, { key: "v", ctrlKey: true });
        await painted();
        expect(rowCount("Then")).toBe(before + 1);
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
        await painted();
        expect(rowCount("Then")).toBe(before);
        fireEvent.keyDown(window, { key: "y", ctrlKey: true });
        await painted();
        expect(rowCount("Then")).toBe(before + 1);
    });

    it("deletes a block from its menu, and Undo in the header brings it back", async () => {
        render(editor(null, "autoOff"));
        await painted();
        const before = rowCount("Then");
        const menus = within(screen.getByRole("list", { name: "Then" })).getAllByRole("button", {
            name: /^More actions/
        });
        fireEvent.pointerDown(menus[0]!, { button: 0, ctrlKey: false });
        fireEvent.click(await screen.findByRole("menuitem", { name: /^Delete/ }));
        await painted();
        expect(rowCount("Then")).toBe(before - 1);
        fireEvent.click(screen.getByRole("button", { name: "Undo change" }));
        await painted();
        expect(rowCount("Then")).toBe(before);
    });

    it("asks before leaving with changes not saved", async () => {
        render(editor(null, "autoOff"));
        await painted();
        fireEvent.click(screen.getByRole("link", { name: /All automations/ }));
        expect(await screen.findByText("Save the new automation?")).toBeDefined();
        fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
        await painted();
        expect(screen.queryByText("Save the new automation?")).toBeNull();
    });

    /** Opens the menu of one row of a stage and picks one of its items. */
    const pick = async (list: string, at: number, item: RegExp) => {
        const menus = within(screen.getByRole("list", { name: list })).getAllByRole("button", {
            name: /^More actions/
        });
        fireEvent.pointerDown(menus[at]!, { button: 0, ctrlKey: false });
        fireEvent.click(await screen.findByRole("menuitem", { name: item }));
        await painted();
    };
    const undoButton = () => screen.getByRole("button", { name: "Undo change" });
    const redoButton = () => screen.getByRole("button", { name: "Redo change" });
    const renameIn = async (list: string, at: number, name: string) => {
        await pick(list, at, /^Rename/);
        const dialog = await screen.findByRole("dialog");
        fireEvent.change(within(dialog).getByLabelText("Name shown instead of the sentence"), {
            target: { value: name }
        });
        fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
        await painted();
    };

    it("saves a stored automation with only what was changed in it", async () => {
        render(editor("auto-1"));
        await painted();
        await pick("When", 0, /^Add note/);
        const dialog = await screen.findByRole("dialog");
        fireEvent.change(within(dialog).getByLabelText("Note on this block"), {
            target: { value: "Pressed from the hall" }
        });
        fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
        await painted();
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await painted();
        expect(saved).toEqual([
            {
                ...inputOf(SAVED),
                definition: {
                    ...SAVED.definition,
                    triggers: [{ ...SAVED.definition.triggers[0], note: "Pressed from the hall" }]
                }
            }
        ]);
    });

    it("has nothing to save once every change is taken back", async () => {
        render(editor("auto-1"));
        await painted();
        await pick("Then", 0, /^Duplicate/);
        expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).not.toBe(
            "true"
        );
        fireEvent.click(undoButton());
        await painted();
        expect(rowCount("Then")).toBe(1);
        expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe(
            "true"
        );
    });

    it("undoes only as far as the first change and redoes only as far as the last", async () => {
        render(editor("auto-1"));
        await painted();
        expect(undoButton().hasAttribute("disabled")).toBe(true);
        expect(redoButton().hasAttribute("disabled")).toBe(true);
        await pick("Then", 0, /^Duplicate/);
        expect(undoButton().hasAttribute("disabled")).toBe(false);
        expect(redoButton().hasAttribute("disabled")).toBe(true);
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
        await painted();
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
        await painted();
        expect(rowCount("Then")).toBe(1);
        expect(undoButton().hasAttribute("disabled")).toBe(true);
        fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
        await painted();
        fireEvent.keyDown(window, { key: "y", ctrlKey: true });
        await painted();
        expect(rowCount("Then")).toBe(2);
        expect(redoButton().hasAttribute("disabled")).toBe(true);
    });

    it("leaves the editor's shortcuts alone while a field is typed into", async () => {
        render(editor("auto-1"));
        await painted();
        await pick("Then", 0, /^Duplicate/);
        fireEvent.keyDown(screen.getAllByRole("textbox")[0]!, { key: "z", ctrlKey: true });
        await painted();
        expect(rowCount("Then")).toBe(2);
    });

    it("saves with Ctrl+S", async () => {
        render(editor(null, "autoOff"));
        await painted();
        fireEvent.keyDown(window, { key: "s", ctrlKey: true });
        await painted();
        expect(saved).toHaveLength(1);
    });

    it("cuts a block with the keyboard and pastes it back where the list ends", async () => {
        render(editor("auto-1"));
        await painted();
        await pick("Then", 0, /^Duplicate/);
        await renameIn("Then", 1, "Second one");
        openRow("Then", 0);
        fireEvent.keyDown(window, { key: "x", ctrlKey: true });
        await painted();
        expect(rowCount("Then")).toBe(1);
        expect(rowsIn("Then")[0]!.textContent).toContain("Second one");
        fireEvent.keyDown(window, { key: "v", ctrlKey: true });
        await painted();
        expect(rowCount("Then")).toBe(2);
        expect(rowsIn("Then")[0]!.textContent).toContain("Second one");
        expect(rowsIn("Then")[1]!.textContent).not.toContain("Second one");
    });

    it("pastes a block copied in another automation, from the row menu", async () => {
        render(editor("auto-1"));
        await painted();
        await pick("Then", 0, /^Copy/);
        cleanup();
        render(editor(null, "autoOff"));
        await painted();
        const before = rowCount("Then");
        await pick("Then", 0, /^Paste/);
        expect(rowCount("Then")).toBe(before + 1);
    });

    it("offers no paste where the copied block does not belong", async () => {
        render(editor("auto-1"));
        await painted();
        await pick("Then", 0, /^Copy/);
        const menus = within(screen.getByRole("list", { name: "When" })).getAllByRole("button", {
            name: /^More actions/
        });
        fireEvent.pointerDown(menus[0]!, { button: 0, ctrlKey: false });
        await screen.findByRole("menuitem", { name: /^Copy/ });
        expect(screen.queryByRole("menuitem", { name: /^Paste/ })).toBeNull();
    });

    it("duplicates and moves a block from its menu", async () => {
        render(editor("auto-1"));
        await painted();
        await pick("Then", 0, /^Duplicate/);
        expect(rowCount("Then")).toBe(2);
        await renameIn("Then", 1, "Second one");
        await pick("Then", 1, /^Move up/);
        expect(rowsIn("Then")[0]!.textContent).toContain("Second one");
        await pick("Then", 0, /^Move down/);
        expect(rowsIn("Then")[1]!.textContent).toContain("Second one");
    });

    it("deletes the selected block with Ctrl+Delete", async () => {
        render(editor(null, "autoOff"));
        await painted();
        const before = rowCount("Then");
        openRow("Then");
        fireEvent.keyDown(window, { key: "Delete", ctrlKey: true });
        await painted();
        expect(rowCount("Then")).toBe(before - 1);
    });

    it("leaves without saving when asked to", async () => {
        render(editor(null, "autoOff"));
        await painted();
        fireEvent.click(screen.getByRole("link", { name: /All automations/ }));
        fireEvent.click(await screen.findByRole("button", { name: /^Leave without/ }));
        await painted();
        expect(saved).toHaveLength(0);
        expect(pushed).toHaveLength(1);
    });

    it("saves and then leaves", async () => {
        render(editor(null, "autoOff"));
        await painted();
        fireEvent.click(screen.getByRole("link", { name: /All automations/ }));
        fireEvent.click(await screen.findByRole("button", { name: "Save and leave" }));
        await painted();
        expect(saved).toHaveLength(1);
        expect(pushed).toHaveLength(1);
    });

    it("lets a link go without asking when nothing changed", async () => {
        render(editor("auto-1"));
        await painted();
        fireEvent.click(screen.getByRole("link", { name: /All automations/ }));
        await painted();
        expect(screen.queryByText("Save changes?")).toBeNull();
    });

    it("edits a block beside the list on a wide screen", async () => {
        render(editor("auto-1"));
        await painted();
        openRow("Then");
        await painted();
        expect(screen.getByRole("complementary")).toBeDefined();
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("edits a block in a sheet from the bottom on a phone", async () => {
        const original = window.matchMedia;
        window.matchMedia = ((query: string) => ({
            matches: false,
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined
        })) as unknown as typeof window.matchMedia;
        try {
            render(editor("auto-1"));
            await painted();
            openRow("Then");
            await painted();
            const sheet = await screen.findByRole("dialog");
            expect(sheet.className).toContain("bottom-0");
            expect(sheet.className).toContain("w-full");
            expect(screen.queryByRole("complementary")).toBeNull();
            fireEvent.click(within(sheet).getByRole("button", { name: "Close panel" }));
            await painted();
            expect(screen.queryByRole("dialog")).toBeNull();
        } finally {
            window.matchMedia = original;
        }
    });
});
