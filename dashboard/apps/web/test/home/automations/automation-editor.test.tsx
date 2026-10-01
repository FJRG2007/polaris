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

const replaced: string[] = [];
const saved: unknown[] = [];
let toggleAnswer: { error?: string; automation?: AutomationView } = {};

vi.mock("next/navigation", async (original) => ({
    ...(await original<typeof import("next/navigation")>()),
    useRouter: () => ({
        replace: (href: string) => replaced.push(href),
        push: vi.fn(),
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
        automation: id === "auto-climate" ? CLIMATE_SAVED : id ? SAVED : undefined,
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

const { AutomationEditor } = await import(
    "@polaris-app/places/src/screens/automations/automation-editor"
);
const { AutomationsView } = await import(
    "@polaris-app/places/src/screens/automations/automations-view"
);

async function painted(): Promise<void> {
    await act(async () => {
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });
}

function openMenu(name: string): void {
    fireEvent.pointerDown(screen.getByRole("button", { name }), { button: 0, ctrlKey: false });
}

beforeEach(() => {
    replaced.length = 0;
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
        fireEvent.change(screen.getByLabelText(/^For/), { target: { value: "0" } });
        expect(screen.getByText("That is too small.")).toBeDefined();
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
        const first = screen.getByLabelText(/Message/).closest("div.rounded-lg") as HTMLElement;
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
