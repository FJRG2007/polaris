// @vitest-environment jsdom

/**
 * The Events tab, used the way an operator would: it draws before the server
 * answers, lists what can be run, runs one, and will not run one from settings
 * that are not saved yet - and the editor says what is wrong beside the field.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const started: string[] = [];
let answerRead: (value: unknown) => void = () => undefined;
let locale = "en-US";

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        i18nProvider: { useLocale: () => locale },
        confirmDialog: { useConfirm: () => [async () => true, null] },
        displayFormat: {
            useDisplayFormat: () => ({ dateTime: (at: number) => new Date(at).toISOString() })
        },
        liveRead: { useKeptSnapshot: () => undefined },
        snapshotCache: {
            readSnapshot: () => null,
            writeSnapshot: () => undefined,
            dropSnapshots: () => undefined
        }
    }
}));

const catalog = await import("@polaris-app/game-servers/src/lib/minecraft/events/catalog");

const config = {
    ...catalog.defaultEventsConfig(),
    presets: [catalog.newPreset("fishing", "fish"), catalog.newPreset("mining-rush", "rush")]
};
const view = {
    config,
    run: null,
    history: [
        {
            id: "h1",
            presetId: "fish",
            kind: "fishing",
            name: "Fishing contest",
            trigger: "random",
            outcome: "finished",
            note: "Ran its full time",
            startedAt: Date.parse("2026-09-27T20:00:00Z"),
            endedAt: Date.parse("2026-09-27T20:10:00Z"),
            participants: 4,
            podium: [{ place: 1, name: "Ana", score: 6 }],
            disqualified: []
        }
    ],
    pending: [],
    nextRandomAt: null,
    waiting: null,
    players: { online: 3, active: 2 },
    refusal: null
};

vi.mock("@polaris-app/game-servers/src/screens/installed/events-actions", () => ({
    readEventsAction: () =>
        new Promise((resolve) => {
            answerRead = resolve;
        }),
    saveEventsAction: async () => ({ view }),
    startEventAction: async (input: { presetId: string }) => {
        started.push(input.presetId);
        return { view };
    },
    startNowAction: async () => ({ view }),
    cancelEventAction: async () => ({ view }),
    forgetPrizeAction: async () => ({ view })
}));

const { MinecraftEvents } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-events"
);
const { EventEditor } = await import(
    "@polaris-app/game-servers/src/screens/installed/event-editor"
);

afterEach(() => {
    cleanup();
    started.length = 0;
    locale = "en-US";
});

describe("the Events tab", () => {
    it("explains an event from its row", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view });
        await waitFor(() => expect(screen.getByLabelText("What Fishing contest is")).toBeTruthy());
        expect(screen.queryByText(/Most catches with a fishing rod wins/)).toBeNull();
        fireEvent.click(screen.getByLabelText("What Fishing contest is"));
        expect(screen.getByText(/Most catches with a fishing rod wins/)).toBeTruthy();
        expect(screen.getByText(/Ranked from 3 catches/)).toBeTruthy();
        expect(screen.getByText(/Prizes - 1st: 5 diamond, 15 levels/)).toBeTruthy();
    });

    it("draws its sections before the server answers", () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        expect(screen.getByText("Now")).toBeTruthy();
        expect(screen.getByText("Events")).toBeTruthy();
        expect(screen.getByText("Automatic events")).toBeTruthy();
        expect(screen.getByText("History")).toBeTruthy();
        expect(screen.queryByText("Fishing contest")).toBeNull();
    });

    it("lists the events, the players and the history once it answers, and runs one", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view });
        await waitFor(() => expect(screen.getByLabelText("Run Fishing contest now")).toBeTruthy());
        expect(screen.getByText(/3 on the server, 2 of them playing/)).toBeTruthy();
        expect(screen.getByText("1. Ana (6)")).toBeTruthy();
        fireEvent.click(screen.getByLabelText("Run Fishing contest now"));
        await waitFor(() => expect(started).toEqual(["fish"]));
    });

    it("will not run an event from changes that are not saved", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view });
        await waitFor(() => expect(screen.getByLabelText("Run Fishing contest now")).toBeTruthy());
        fireEvent.click(screen.getByLabelText("Fishing contest can come round on its own"));
        await waitFor(() => expect(screen.getByText("Unsaved changes.")).toBeTruthy());
        expect(
            (screen.getByLabelText("Run Fishing contest now") as HTMLButtonElement).disabled
        ).toBe(true);
    });

    it("says what is wrong in the editor beside the field, and holds Done", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view });
        await waitFor(() => expect(screen.getByLabelText("Edit Fishing contest")).toBeTruthy());
        fireEvent.click(screen.getByLabelText("Edit Fishing contest"));
        const name = await screen.findByDisplayValue("Fishing contest");
        fireEvent.change(name, { target: { value: "  " } });
        await waitFor(() =>
            expect(screen.getAllByText("Give it a name").length).toBeGreaterThan(0)
        );
        expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(name, { target: { value: "Friday fishing" } });
        await waitFor(() =>
            expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(false)
        );
    });

    it("lets somebody without the grant look but not change anything", async () => {
        render(
            <MinecraftEvents
                installedAppId="00000000-0000-4000-8000-000000000001"
                canManage={false}
            />
        );
        answerRead({ view });
        await waitFor(() => expect(screen.getByLabelText("Run Fishing contest now")).toBeTruthy());
        expect(
            (screen.getByLabelText("Run Fishing contest now") as HTMLButtonElement).disabled
        ).toBe(true);
        expect((screen.getByLabelText("Edit Fishing contest") as HTMLButtonElement).disabled).toBe(
            true
        );
    });
});
describe("the treasure hunt, gathering, rare catch and experience boost", () => {
    const kinds = {
        ...view,
        history: [],
        config: {
            ...config,
            presets: [
                catalog.newPreset("treasure-hunt", "hunt"),
                catalog.newPreset("gathering", "gather"),
                catalog.newPreset("rare-catch", "catch"),
                catalog.newPreset("xp-boost", "boost")
            ]
        }
    };

    it("explains what each does to the world and what it guarantees", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view: kinds });
        await waitFor(() => expect(screen.getByLabelText("What Treasure hunt is")).toBeTruthy());
        for (const name of ["Treasure hunt", "Gathering", "Rare catch", "Experience boost"])
            fireEvent.click(screen.getByLabelText(`What ${name} is`));
        expect(screen.getByText(/5 chests hidden up to 300 blocks from the players/)).toBeTruthy();
        expect(screen.getByText(/one nobody opened is taken away at the end/)).toBeTruthy();
        expect(screen.getByText(/The material is drawn from the list each time/)).toBeTruthy();
        expect(screen.getByText(/never more than they picked up during it/)).toBeTruthy();
        expect(screen.getByText(/fish up any fishing treasure wins, and keeps it/)).toBeTruthy();
        expect(
            screen.getByText(/5 extra experience per mob killed and 3 per ore block mined/)
        ).toBeTruthy();
    });

    it("holds Done while a boost gives nothing, and says why", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view: kinds });
        await waitFor(() => expect(screen.getByLabelText("Edit Experience boost")).toBeTruthy());
        fireEvent.click(screen.getByLabelText("Edit Experience boost"));
        fireEvent.change(await screen.findByLabelText(/^Extra per mob killed/), {
            target: { value: "0" }
        });
        fireEvent.change(screen.getByLabelText(/^Extra per ore mined/), { target: { value: "0" } });
        await waitFor(() =>
            expect(
                screen.getAllByText("Give something for kills, ores or both").length
            ).toBeGreaterThan(0)
        );
        expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(true);
    });

    it("says beside the field when a hunt asks for too many chests", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view: kinds });
        await waitFor(() => expect(screen.getByLabelText("Edit Treasure hunt")).toBeTruthy());
        fireEvent.click(screen.getByLabelText("Edit Treasure hunt"));
        fireEvent.change(await screen.findByLabelText(/^Chests/), { target: { value: "11" } });
        await waitFor(() => expect(screen.getAllByText("At most 10").length).toBeGreaterThan(0));
        expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(true);
    });
});

describe("setting up a horde defence", () => {
    it("asks for waves, their size and the monsters, and not for minutes", () => {
        const preset = catalog.newPreset("waves", "waves");
        render(
            <EventEditor
                preset={preset}
                open
                onOpenChange={() => undefined}
                onSave={() => undefined}
            />
        );
        expect(screen.getByText("Horde defence")).toBeTruthy();
        expect(screen.queryByText("Minutes")).toBeNull();
        expect(screen.getByLabelText("Monsters")).toBeTruthy();
        const waves = screen.getByLabelText(/^Waves/) as HTMLInputElement;
        expect(waves.value).toBe("5");
        fireEvent.change(waves, { target: { value: "12" } });
        expect(screen.getAllByText("At most 10 waves").length).toBeGreaterThan(0);
        expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(waves, { target: { value: "7" } });
        expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(false);
    });
});

describe("setting up a meteor shower", () => {
    it("asks how many meteors, how big and of what, and says what is wrong", () => {
        const preset = catalog.newPreset("meteor-shower", "meteors");
        render(
            <EventEditor
                preset={preset}
                open
                onOpenChange={() => undefined}
                onSave={() => undefined}
            />
        );
        expect(screen.getByText("Meteor shower")).toBeTruthy();
        expect(screen.getByLabelText("Made of")).toBeTruthy();
        const count = screen.getByLabelText(/^Meteors/) as HTMLInputElement;
        expect(count.value).toBe("4");
        fireEvent.change(count, { target: { value: "20" } });
        expect(screen.getAllByText("At most 8").length).toBeGreaterThan(0);
        expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(true);
    });
});

describe("the parkour and spleef editors", () => {
    it("sets a course's jumps, difficulty and height, and says a wrong one beside the field", async () => {
        const { EventEditor } = await import(
            "@polaris-app/game-servers/src/screens/installed/event-editor"
        );
        const saved: unknown[] = [];
        render(
            <EventEditor
                preset={catalog.newPreset("parkour", "race")}
                open
                onOpenChange={() => undefined}
                onSave={(preset) => saved.push(preset)}
            />
        );
        const jumps = screen.getByDisplayValue("20");
        expect(screen.getByText("Difficulty")).toBeTruthy();
        fireEvent.change(jumps, { target: { value: "5" } });
        await waitFor(() => expect(screen.getAllByText("At least 10").length).toBeGreaterThan(0));
        expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(jumps, { target: { value: "30" } });
        await waitFor(() =>
            expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(false)
        );
        fireEvent.click(screen.getByText("Done"));
        expect((saved[0] as { options: { jumps: number } }).options.jumps).toBe(30);
    });

    it("says how big a spleef floor comes out", async () => {
        const { EventEditor } = await import(
            "@polaris-app/game-servers/src/screens/installed/event-editor"
        );
        render(
            <EventEditor
                preset={catalog.newPreset("spleef", "floor")}
                open
                onOpenChange={() => undefined}
                onSave={() => undefined}
            />
        );
        expect(screen.getByText("5 to 15: this one is 17 by 17.")).toBeTruthy();
        // The size, not the minutes or the height.
        const size = screen
            .getAllByDisplayValue("8")
            .find((input) => input.getAttribute("max") === "15")!;
        fireEvent.change(size, { target: { value: "20" } });
        await waitFor(() => expect(screen.getAllByText("At most 15").length).toBeGreaterThan(0));
    });

    it("explains who takes part and what it guarantees", async () => {
        const withArena = {
            ...view,
            config: { ...config, presets: [catalog.newPreset("spleef", "floor")] }
        };
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view: withArena });
        await waitFor(() => expect(screen.getByLabelText("What Spleef is")).toBeTruthy());
        fireEvent.click(screen.getByLabelText("What Spleef is"));
        expect(screen.getByText(/type join \(or unirse\) in the chat/)).toBeTruthy();
        expect(screen.getByText(/only what it placed/)).toBeTruthy();
        expect(screen.getByText(/marked shovel that only breaks the snow/)).toBeTruthy();
    });
});

describe("the editor of an event players join", () => {
    const edit = async (preset: catalog.EventPreset, saved: catalog.EventPreset[]) => {
        const { EventEditor } = await import(
            "@polaris-app/game-servers/src/screens/installed/event-editor"
        );
        render(
            <EventEditor
                preset={preset}
                open
                onOpenChange={() => undefined}
                onSave={(next) => saved.push(next)}
            />
        );
    };
    const done = () => screen.getByText("Done") as HTMLButtonElement;

    it("asks a build battle of your own themes for one, and takes them one a line", async () => {
        const saved: catalog.EventPreset[] = [];
        await edit(catalog.newPreset("build-battle", "build"), saved);
        expect(screen.getByText("Minutes to build")).toBeTruthy();
        expect(screen.getByText(/One of 30 built-in themes/)).toBeTruthy();
        fireEvent.click(screen.getByText("My own"));
        await waitFor(() =>
            expect(screen.getAllByText("Write at least one theme").length).toBeGreaterThan(0)
        );
        expect(done().disabled).toBe(true);
        fireEvent.change(screen.getByPlaceholderText(/Our spawn town/), {
            target: { value: "A dragon\n  Our town \n" }
        });
        await waitFor(() => expect(done().disabled).toBe(false));
        fireEvent.click(done());
        expect((saved[0]?.options as catalog.EventOptions<"build-battle">).themes).toEqual([
            "A dragon",
            "Our town"
        ]);
    });

    it("holds a duel's hearts between one and six", async () => {
        const saved: catalog.EventPreset[] = [];
        await edit(catalog.newPreset("team-duel", "duel"), saved);
        expect(screen.getByText(/sent back to their side, healed/)).toBeTruthy();
        const hearts = screen
            .getAllByDisplayValue("3")
            .find((input) => input.getAttribute("max") === "6")!;
        fireEvent.change(hearts, { target: { value: "9" } });
        await waitFor(() => expect(done().disabled).toBe(true));
        fireEvent.change(hearts, { target: { value: "2" } });
        await waitFor(() => expect(done().disabled).toBe(false));
        fireEvent.click(done());
        expect((saved[0]?.options as catalog.EventOptions<"team-duel">).downHearts).toBe(2);
    });
});

describe("the editor in Spanish", () => {
    it("names the fields and where it happens in the reader's language", () => {
        locale = "es-ES";
        render(
            <EventEditor
                preset={catalog.newPreset("team-duel", "duel")}
                open
                onOpenChange={() => undefined}
                onSave={() => undefined}
            />
        );
        expect(screen.getByText("Fuera a (corazones)")).toBeTruthy();
        expect(screen.getByText("El mismo para todos, y se retira al final.")).toBeTruthy();
        expect(screen.getByText(/La arena se construye 30 bloques en alto/)).toBeTruthy();
        expect(screen.queryByText(/around a player who is in the Overworld/)).toBeNull();
    });

    it("says how big a spleef floor comes out", () => {
        locale = "es-ES";
        render(
            <EventEditor
                preset={catalog.newPreset("spleef", "floor")}
                open
                onOpenChange={() => undefined}
                onSave={() => undefined}
            />
        );
        expect(screen.getByText("De 5 a 15: este mide 17 por 17.")).toBeTruthy();
    });

    it("names each choice in the reader's language", async () => {
        const { options, LOOT_LABELS } = await import(
            "@polaris-app/game-servers/src/screens/installed/event-editor"
        );
        const { gameCatalogs } = await import("@polaris-app/game-servers/messages");
        expect(options(gameCatalogs.translator("es-ES", "minecraft"), LOOT_LABELS)[0]).toEqual({
            value: "treasure",
            label: "Tesoro enterrado"
        });
    });
});
