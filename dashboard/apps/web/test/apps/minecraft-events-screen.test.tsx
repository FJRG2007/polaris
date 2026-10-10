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
        copyButton: {
            CopyButton: ({ label }: { label?: string }) => <button aria-label={label} />
        },
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
    stashFailures: [] as {
        id: string;
        player: string;
        event: string;
        note: string | null;
        barrels: { x: number; y: number; z: number }[];
        missing: number;
        at: string;
    }[],
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
    forgetPrizeAction: async () => ({ view }),
    retryStashAction: async (input: { id: string }) => {
        retried.push(input.id);
        return { view: { ...view, stashFailures: [] }, outcome: "done" };
    },
    dismissStashAction: async () => ({ view: { ...view, stashFailures: [] } }),
    retryArenaAction: async (input: { id: string }) => {
        retriedArenas.push(input.id);
        return { view: { ...view, arenaRemains: [] }, outcome: "cleared" };
    },
    dismissArenaAction: async () => ({ view: { ...view, arenaRemains: [] } }),
    forceJoinAction: async (input: { who: string; players?: string[] }) => {
        forcedAsks.push(input);
        return {
            view: { ...view, run: { ...joinable, forced: [{ name: "Ben", byName: "Op", at: 0 }] } },
            brought: 1,
            offline: []
        };
    }
}));

const forcedAsks: { who: string; players?: string[] }[] = [];
const joinable = {
    presetId: "pk",
    name: "Parkour race",
    kind: "parkour",
    phase: "countdown",
    startsAt: Date.now() + 60_000,
    endsAt: Date.now() + 360_000,
    trigger: "manual",
    cancelling: false,
    standings: [],
    takesForced: true,
    inEvent: ["Ana"],
    forced: [],
    online: ["Ana", "Ben", "Cy"]
};

const retried: string[] = [];
const retriedArenas: string[] = [];

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
    it("marks an event incompatible only on a server too old for it, and says why", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({
            view: {
                ...view,
                version: "1.16.5",
                config: {
                    ...config,
                    presets: [
                        catalog.newPreset("sky-wars", "sky"),
                        catalog.newPreset("parkour", "pk")
                    ]
                }
            }
        });
        const why = await screen.findByText(
            "Needs Minecraft 1.17 or later; this server runs 1.16.5."
        );
        expect(why).toBeTruthy();
        expect(screen.getAllByText("Incompatible")).toHaveLength(1);
        expect(screen.getByLabelText("Run SkyWars now").hasAttribute("disabled")).toBe(true);
        // The parkour plays on 1.16.5: no version said anywhere about it.
        expect(document.body.textContent).not.toMatch(/1\.14|Needs Java/);
    });

    it("says nothing about versions when the server can play everything", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({
            view: {
                ...view,
                version: "1.21.4",
                config: { ...config, presets: [catalog.newPreset("sky-wars", "sky")] }
            }
        });
        await screen.findByText("SkyWars");
        expect(screen.queryByText("Incompatible")).toBeNull();
    });

    it("groups the events by where they are played", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({
            view: {
                ...view,
                config: {
                    ...config,
                    presets: [
                        catalog.newPreset("fishing", "fish"),
                        catalog.newPreset("sky-wars", "sky"),
                        catalog.newPreset("supply-drop", "drop")
                    ]
                }
            }
        });
        const sky = await screen.findByRole("region", { name: "Built in the sky" });
        expect(sky.textContent).toContain("SkyWars");
        expect(sky.textContent).not.toContain("Fishing contest");
        const world = screen.getByRole("region", { name: "Somewhere in the world" });
        expect(world.textContent).toContain("Supply drop");
        const anywhere = screen.getByRole("region", { name: "Wherever players are" });
        expect(anywhere.textContent).toContain("Fishing contest");
        // In the order the groups are shown: the sky first.
        const regions = screen
            .getAllByRole("region")
            .map((one) => one.getAttribute("aria-labelledby"));
        expect(regions).toEqual(["held-sky", "held-world", "held-anywhere"]);
    });

    it("shows a player's things an event could not give back, and gives them back from there", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({
            view: {
                ...view,
                stashFailures: [
                    {
                        id: "00000000-0000-7000-8000-000000000001",
                        player: "Ana",
                        event: "Team duel",
                        note: "1 stack(s) could not be given back and checked",
                        barrels: [{ x: 10, y: 99, z: -4 }],
                        missing: 1,
                        at: "2026-09-29T20:00:00Z"
                    }
                ]
            }
        });
        await waitFor(() => expect(screen.getByText("Things not given back")).toBeTruthy());
        expect(screen.getByText(/1 stack in the barrels at 10 99 -4/)).toBeTruthy();
        fireEvent.click(screen.getByLabelText("Give back now"));
        await waitFor(() => expect(retried).toEqual(["00000000-0000-7000-8000-000000000001"]));
        await waitFor(() => expect(screen.getByText("Ana has their things back.")).toBeTruthy());
        expect(screen.queryByText("Things not given back")).toBeNull();
        retried.length = 0;
    });

    it("names where an arena's leftover blocks are, and takes it down again from there", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({
            view: {
                ...view,
                arenaRemains: [
                    {
                        id: "run-7",
                        kind: "hide-and-seek",
                        box: { x1: -40, y1: 96, z1: 12, x2: 30, y2: 130, z2: 80 },
                        count: 9
                    }
                ]
            }
        });
        await waitFor(() => expect(screen.getByText("Blocks left behind by events")).toBeTruthy());
        expect(screen.getByText(/between -40 96 12 and 30 130 80 - 9 blocks left/)).toBeTruthy();
        expect(screen.getByLabelText("Copy the corners")).toBeTruthy();
        fireEvent.click(screen.getByLabelText("Take it down again"));
        await waitFor(() => expect(retriedArenas).toEqual(["run-7"]));
        await waitFor(() => expect(screen.getByText("That space is empty now.")).toBeTruthy());
        expect(screen.queryByText("Blocks left behind by events")).toBeNull();
    });

    it("does not offer to run an event with fewer on the server than it needs, and says why", async () => {
        const build = catalog.newPreset("build-battle", "build");
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({
            view: {
                ...view,
                players: { online: 2, active: 2 },
                config: { ...config, presets: [build, catalog.newPreset("fishing", "fish")] }
            }
        });
        const run = (await screen.findByLabelText("Run Build battle now")) as HTMLButtonElement;
        expect(run.disabled).toBe(true);
        expect(run.title).toBe("Only 2 players are on the server; this event needs 3");
        expect(
            (screen.getByLabelText("Run Fishing contest now") as HTMLButtonElement).disabled
        ).toBe(false);
    });

    it("explains an event from its row", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view });
        await waitFor(() => expect(screen.getByLabelText("What Fishing contest is")).toBeTruthy());
        expect(screen.queryByText(/Most catches with a fishing rod wins/)).toBeNull();
        fireEvent.click(screen.getByLabelText("What Fishing contest is"));
        expect(screen.getByText(/Most catches with a fishing rod wins/)).toBeTruthy();
        expect(screen.getByText(/Ranked from 3 catches/)).toBeTruthy();
        expect(
            screen.getByText(/Prizes - 1st: 1 diamond, 8 experience bottle, 3 levels/)
        ).toBeTruthy();
    });

    it("lists every prize of an event on its row, whole in the tooltip", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view });
        const line =
            "1st 1 diamond + 8 experience bottle + 3 levels · 2nd 4 gold ingot + 4 experience bottle + 2 levels · 3rd 4 iron ingot + 2 experience bottle + 1 level · Everybody else: 3 experience bottle";
        const row = await screen.findAllByTitle(`Fishing contest - 8 min - ${line}`);
        expect(row[0]?.textContent).toBe(`Fishing contest - 8 min - ${line}`);
        expect(row[0]?.className).toContain("truncate");
    });

    it("lists the prizes in the reader's language, and says when there are none", async () => {
        locale = "es-ES";
        const nothing = { items: [], levels: 0 };
        const bare = { first: nothing, second: nothing, third: nothing, everyone: nothing };
        const none = { ...catalog.newPreset("mining-rush", "rush"), rewards: bare };
        const levels = {
            ...catalog.newPreset("fishing", "fish"),
            rewards: {
                ...bare,
                first: { items: [], levels: 1 },
                everyone: { items: [], levels: 2 }
            }
        };
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view: { ...view, config: { ...config, presets: [levels, none] } } });
        const row = await screen.findByText(/1\.º 1 nivel · El resto: 2 niveles$/);
        expect(row.textContent).toMatch(/^Concurso de pesca - /);
        expect(screen.getByText(/ - Sin premios$/)).toBeTruthy();
    });

    it("leaves out a place with no prize of its own, and says everybody when none has one", async () => {
        const nothing = { items: [], levels: 0 };
        const bottles = { items: [{ id: "minecraft:experience_bottle", count: 8 }], levels: 0 };
        const gap = {
            ...catalog.newPreset("fishing", "fish"),
            rewards: {
                first: { items: [], levels: 15 },
                second: nothing,
                third: { items: [], levels: 5 },
                everyone: bottles
            }
        };
        const flat = {
            ...catalog.newPreset("mining-rush", "rush"),
            rewards: { first: nothing, second: nothing, third: nothing, everyone: bottles }
        };
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view: { ...view, config: { ...config, presets: [gap, flat] } } });
        expect(
            await screen.findByText(
                / - 1st 15 levels · 3rd 5 levels · Everybody else: 8 experience bottle$/
            )
        ).toBeTruthy();
        const row = screen.getByText(/ - Everybody: 8 experience bottle$/);
        expect(row.getAttribute("title")).toBe(row.textContent);
        expect(row.className).toContain("truncate");
        expect(row.parentElement?.className).toContain("min-w-0");
        fireEvent.click(screen.getByLabelText("What Mining rush is"));
        expect(screen.getByText("Prizes - everybody: 8 experience bottle.")).toBeTruthy();
    });

    it("brings the chosen players into the event on now, offering only who is not in", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view: { ...view, run: joinable } });
        fireEvent.click(await screen.findByRole("button", { name: "Bring players in" }));
        // Ana is in already: not offered.
        expect(screen.queryByText("Ana")).toBeNull();
        expect(screen.getByText("Everybody on the server (2)")).toBeTruthy();
        // Nobody chosen yet: nothing to confirm.
        expect(
            screen.getByRole("button", { name: "Bring players in" }).hasAttribute("disabled")
        ).toBe(true);
        fireEvent.click(screen.getByLabelText("Ben"));
        fireEvent.click(screen.getByRole("button", { name: "Bring 1 player in" }));
        await waitFor(() =>
            expect(forcedAsks).toEqual([
                {
                    installedAppId: "00000000-0000-4000-8000-000000000001",
                    who: "chosen",
                    players: ["Ben"]
                }
            ])
        );
        expect(await screen.findByText("Ben, by Op")).toBeTruthy();
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

    it("shows a race's history finish as the time it took, never as its raw score", async () => {
        const raced = {
            ...view,
            history: [
                {
                    ...view.history[0]!,
                    id: "h2",
                    presetId: "fish",
                    kind: "boat-race" as const,
                    name: "Ice boat race",
                    // A finish is kept as FINISH_BASE minus the seconds it
                    // took, so 83 seconds is scored 99917.
                    podium: [{ place: 1, name: "Ana", score: 99_917 }]
                }
            ]
        };
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view: raced });
        expect(await screen.findByText("1. Ana (1.4 min)")).toBeTruthy();
        expect(screen.queryByText(/laps/)).toBeNull();
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
        expect(screen.getByText(/1 chest hidden up to 300 blocks from the players/)).toBeTruthy();
        expect(screen.getByText(/one nobody opened is taken away at the end/)).toBeTruthy();
        expect(screen.getByText(/3 rounds of 2 minutes/)).toBeTruthy();
        expect(screen.getByText(/Each round's material is drawn from the list/)).toBeTruthy();
        expect(screen.getByText(/A column of light stands over every chest/)).toBeTruthy();
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

    it("says beside the field when a hunt's treasure is too far out, and asks no number of chests", async () => {
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view: kinds });
        await waitFor(() => expect(screen.getByLabelText("Edit Treasure hunt")).toBeTruthy());
        fireEvent.click(screen.getByLabelText("Edit Treasure hunt"));
        expect(screen.queryByLabelText(/^Chests/)).toBeNull();
        fireEvent.change(await screen.findByLabelText(/^How far out/), {
            target: { value: "2000" }
        });
        await waitFor(() => expect(screen.getAllByText("At most 1000").length).toBeGreaterThan(0));
        expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(true);
    });
});

describe("setting up a horde defense", () => {
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
        expect(screen.getByText("Horde defense")).toBeTruthy();
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

    it("lets Done save a new event as it opens, before anything is changed", () => {
        const saved: catalog.EventPreset[] = [];
        const preset = catalog.newPreset("waves", "waves");
        render(
            <EventEditor
                preset={preset}
                isNew
                open
                onOpenChange={() => undefined}
                onSave={(next) => saved.push(next)}
            />
        );
        expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(screen.getByText("Done"));
        expect(saved).toEqual([preset]);
    });

    it("holds Done for an existing event until something changes", () => {
        render(
            <EventEditor
                preset={catalog.newPreset("waves", "waves")}
                open
                onOpenChange={() => undefined}
                onSave={() => undefined}
            />
        );
        expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(true);
    });
});

describe("setting up a king of the ring", () => {
    it("offers rounds, shrinking and moving with fists only, and hides them without", () => {
        const saved: catalog.EventPreset[] = [];
        render(
            <EventEditor
                preset={catalog.newPreset("king-of-the-hill", "ring")}
                open
                onOpenChange={() => undefined}
                onSave={(next) => saved.push(next)}
            />
        );
        const rounds = screen.getByLabelText(/^Rounds/) as HTMLInputElement;
        expect(rounds.value).toBe("3");
        for (const label of ["The ring shrinks", "The ring moves"])
            expect(screen.getByLabelText(label).getAttribute("aria-checked")).toBe("true");
        fireEvent.change(rounds, { target: { value: "6" } });
        expect(screen.getAllByText("At most 5").length).toBeGreaterThan(0);
        fireEvent.change(rounds, { target: { value: "2" } });
        fireEvent.click(screen.getByLabelText("The ring moves"));
        fireEvent.click(screen.getByText("Done"));
        const options = saved.at(-1)!.options as catalog.EventOptions<"king-of-the-hill">;
        expect([options.rounds, options.shrinks, options.moves]).toEqual([2, true, false]);
        fireEvent.click(screen.getByLabelText("Fists only, nobody dies"));
        expect(screen.queryByLabelText(/^Rounds/)).toBeNull();
    });
});

describe("setting up a spleef", () => {
    it("offers every way to play switched on, and never lets the last one go", () => {
        const saved: catalog.EventPreset[] = [];
        render(
            <EventEditor
                preset={catalog.newPreset("spleef", "spleef")}
                open
                onOpenChange={() => undefined}
                onSave={(next) => saved.push(next)}
            />
        );
        expect(screen.getByText("Ways it is played")).toBeTruthy();
        const way = (label: string) => screen.getByLabelText(label) as HTMLButtonElement;
        for (const label of [
            "Shovels: dig the snow",
            "Vanishing floor",
            "Snowballs: break their floor"
        ])
            expect(way(label).getAttribute("aria-checked")).toBe("true");
        fireEvent.click(way("Snowballs: break their floor"));
        fireEvent.click(way("Vanishing floor"));
        // The one left on cannot be switched off.
        expect(way("Shovels: dig the snow").disabled).toBe(true);
        fireEvent.click(screen.getByText("Done"));
        const options = saved.at(-1)!.options as catalog.EventOptions<"spleef">;
        expect(options.variants).toEqual(["shovel"]);
    });
});

describe("setting up a world boss", () => {
    it("asks how hard, whether in the sky arena, and which bosses it draws from", () => {
        const saved: catalog.EventPreset[] = [];
        render(
            <EventEditor
                preset={catalog.newPreset("world-boss", "boss")}
                open
                onOpenChange={() => undefined}
                onSave={(next) => saved.push(next)}
            />
        );
        expect(screen.getByText("Difficulty")).toBeTruthy();
        expect(screen.getByText("Epic")).toBeTruthy();
        expect(
            (screen.getByLabelText("Sky arena") as HTMLButtonElement).getAttribute("aria-checked")
        ).toBe("true");
        expect(screen.getByText("Drawn from")).toBeTruthy();
        // Every boss in the pool, the Wither too while the arena is on.
        expect(screen.getByLabelText("The Blight (Wither)")).toBeTruthy();
        fireEvent.click(screen.getByText("Hard"));
        // Who wins, and the trophy: most damage and on, unless chosen otherwise.
        expect(screen.getByText("How the winner is decided")).toBeTruthy();
        fireEvent.click(screen.getByText("Final blow"));
        const trophy = screen.getByLabelText("Trophy for the winner") as HTMLButtonElement;
        expect(trophy.getAttribute("aria-checked")).toBe("true");
        fireEvent.click(trophy);
        fireEvent.click(screen.getByLabelText("The Captain (pillager)"));
        // Off the arena: the Wither cannot be drawn.
        fireEvent.click(screen.getByLabelText("Sky arena"));
        expect((screen.getByLabelText("The Blight (Wither)") as HTMLButtonElement).disabled).toBe(
            true
        );
        fireEvent.click(screen.getByText("Done"));
        const options = saved.at(-1)!.options as catalog.EventOptions<"world-boss">;
        expect(options.difficulty).toBe("hard");
        expect(options.arena).toBe(false);
        expect(options.choice).toBe("random");
        expect(options.pool).not.toContain("captain");
        expect(options.winner).toBe("final-blow");
        expect(options.trophy).toBe(false);
    });

    it("explains the fight, the arena, the rules it holds and what it pays", async () => {
        const withBoss = {
            ...view,
            config: { ...config, presets: [catalog.newPreset("world-boss", "boss")] }
        };
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view: withBoss });
        await waitFor(() => expect(screen.getByLabelText("What World boss is")).toBeTruthy());
        fireEvent.click(screen.getByLabelText("What World boss is"));
        expect(screen.getByText(/A boss drawn at random each time from/)).toBeTruthy();
        expect(screen.getByText(/Epic\. Three phases/)).toBeTruthy();
        expect(screen.getByText(/closed glass arena built only into empty air/)).toBeTruthy();
        expect(screen.getByText(/Keep inventory is on while it runs/)).toBeTruthy();
        expect(
            screen.getByText(/Mob griefing is off while The Blight \(Wither\) fights/)
        ).toBeTruthy();
        expect(screen.getByText(/multiplied by 2 on this difficulty/)).toBeTruthy();
        expect(screen.getByText(/The most damage dealt to it wins/)).toBeTruthy();
        expect(screen.getByText(/a Nether Star named after the boss/)).toBeTruthy();
        expect(screen.getAllByText(/· Trophy$/).length).toBeGreaterThan(0);
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
        expect(count.value).toBe("10");
        fireEvent.change(count, { target: { value: "40" } });
        expect(screen.getAllByText("At most 30").length).toBeGreaterThan(0);
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
        const jumps = screen.getByLabelText(/^Jumps/) as HTMLInputElement;
        expect(jumps.value).toBe("30");
        expect(screen.getByText("Difficulty")).toBeTruthy();
        fireEvent.change(jumps, { target: { value: "5" } });
        await waitFor(() => expect(screen.getAllByText("At least 10").length).toBeGreaterThan(0));
        expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(jumps, { target: { value: "35" } });
        await waitFor(() =>
            expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(false)
        );
        // Every shape on; the last one left cannot be switched off.
        const tower = screen.getByLabelText("A tower climbed round and round") as HTMLButtonElement;
        expect(tower.getAttribute("aria-checked")).toBe("true");
        for (const label of [
            "Rows climbing back and forth",
            "One long line",
            "A snake winding on",
            "A spiral winding out"
        ]) {
            expect(tower.disabled).toBe(false);
            fireEvent.click(screen.getByLabelText(label));
        }
        expect(tower.disabled).toBe(true);
        fireEvent.click(screen.getByText("Done"));
        const options = (saved[0] as { options: { jumps: number; shapes: string[] } }).options;
        expect(options.jumps).toBe(35);
        expect(options.shapes).toEqual(["tower"]);
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

describe("the TNT run, ice boat race and dropper editors", () => {
    type Preset = ReturnType<typeof catalog.newPreset>;
    const edit = (preset: Preset, saved: Preset[]) =>
        render(
            <EventEditor
                preset={preset}
                open
                onOpenChange={() => undefined}
                onSave={(next) => saved.push(next)}
            />
        );
    const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;

    it("saves a TNT run's floors, and holds them between two and four", async () => {
        const saved: Preset[] = [];
        edit(catalog.newPreset("tnt-run", "tnt"), saved);
        expect(field(/^Floors(?! to)/).value).toBe("3");
        fireEvent.change(field(/^Floors(?! to)/), { target: { value: "5" } });
        await waitFor(() => expect(screen.getAllByText("At most 4").length).toBeGreaterThan(0));
        fireEvent.change(field(/^Floors(?! to)/), { target: { value: "4" } });
        await waitFor(() =>
            expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(false)
        );
        fireEvent.click(screen.getByText("Done"));
        expect(saved.at(-1)!.options).toMatchObject({ layers: 4, size: 9, height: 30 });
    });

    it("saves an ice boat race's laps", async () => {
        const saved: Preset[] = [];
        edit(catalog.newPreset("boat-race", "boats"), saved);
        expect(field(/^Laps/).value).toBe("2");
        fireEvent.change(field(/^Laps/), { target: { value: "3" } });
        await waitFor(() =>
            expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(false)
        );
        fireEvent.click(screen.getByText("Done"));
        expect(saved.at(-1)!.options).toMatchObject({ laps: 3, height: 30 });
    });

    it("saves a downhill boat race's finish height, gentle by default, between 25 and 40", async () => {
        const saved: Preset[] = [];
        edit(catalog.newPreset("downhill-race", "down"), saved);
        expect(screen.getByLabelText("Slope").textContent).toContain("Gentle");
        expect(field(/^Height \(blocks\)/).value).toBe("30");
        fireEvent.change(field(/^Height \(blocks\)/), { target: { value: "41" } });
        await waitFor(() => expect(screen.getAllByText("At most 40").length).toBeGreaterThan(0));
        fireEvent.change(field(/^Height \(blocks\)/), { target: { value: "35" } });
        await waitFor(() =>
            expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(false)
        );
        fireEvent.click(screen.getByText("Done"));
        expect(saved.at(-1)!.options).toMatchObject({ steepness: "gentle", height: 35 });
    });

    it("saves a dropper's floors, and holds them between five and twenty", async () => {
        const saved: Preset[] = [];
        edit(catalog.newPreset("dropper", "drop"), saved);
        expect(field(/^Floors to fall through/).value).toBe("10");
        fireEvent.change(field(/^Floors to fall through/), { target: { value: "21" } });
        await waitFor(() => expect(screen.getAllByText("At most 20").length).toBeGreaterThan(0));
        fireEvent.change(field(/^Floors to fall through/), { target: { value: "15" } });
        await waitFor(() =>
            expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(false)
        );
        fireEvent.click(screen.getByText("Done"));
        expect(saved.at(-1)!.options).toMatchObject({ levels: 15, difficulty: "medium" });
    });

    it("explains each: its map, how it is won, and what it needs", async () => {
        const withThem = {
            ...view,
            config: {
                ...config,
                presets: [
                    catalog.newPreset("tnt-run", "tnt"),
                    catalog.newPreset("boat-race", "boats"),
                    catalog.newPreset("dropper", "drop"),
                    catalog.newPreset("downhill-race", "down")
                ]
            }
        };
        render(<MinecraftEvents installedAppId="00000000-0000-4000-8000-000000000001" canManage />);
        answerRead({ view: withThem });
        await waitFor(() => expect(screen.getByLabelText("What TNT run is")).toBeTruthy());
        fireEvent.click(screen.getByLabelText("What TNT run is"));
        expect(screen.getByText(/3 floors of TNT, 19 by 19/)).toBeTruthy();
        expect(screen.getByText(/Nothing explodes/)).toBeTruthy();
        fireEvent.click(screen.getByLabelText("What Ice boat race is"));
        expect(screen.getByText(/2 laps of an ice track/)).toBeTruthy();
        expect(screen.getByText(/Every racer starts with a boat/)).toBeTruthy();
        fireEvent.click(screen.getByLabelText("What Dropper is"));
        expect(screen.getByText(/A shaft of 10 floors, medium/)).toBeTruthy();
        expect(screen.getByText(/Played under Slow Falling/)).toBeTruthy();
        fireEvent.click(screen.getByLabelText("What Downhill boat race is"));
        expect(screen.getByText(/drops a block every 14 blocks/)).toBeTruthy();
        expect(screen.getByText(/Every racer starts with a boat at the top/)).toBeTruthy();
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

    it("asks nothing about hearts for a duel: a player is out by dying", async () => {
        const saved: catalog.EventPreset[] = [];
        await edit(catalog.newPreset("team-duel", "duel"), saved);
        expect(screen.queryByText(/sent back to their side/)).toBeNull();
        expect(
            screen.queryAllByRole("spinbutton").some((input) => input.getAttribute("max") === "6")
        ).toBe(false);
        expect(catalog.newPreset("team-duel", "duel").options).not.toHaveProperty("downHearts");
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
        expect(screen.getByText("El mismo para todos, y se retira al final.")).toBeTruthy();
        expect(
            screen.getByText("Se cancela si se apuntan menos durante la cuenta atrás.")
        ).toBeTruthy();
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

    it("titles the editor and says what is wrong in the reader's language", async () => {
        locale = "es-ES";
        render(
            <EventEditor
                preset={{ ...catalog.newPreset("treasure-hunt", "hunt"), name: "" }}
                open
                onOpenChange={() => undefined}
                onSave={() => undefined}
            />
        );
        expect(screen.getByText("Caza del tesoro")).toBeTruthy();
        expect(screen.getByText("Mínimo de jugadores")).toBeTruthy();
        expect(screen.getByText("No empieza con menos jugadores conectados.")).toBeTruthy();
        expect((screen.getByLabelText(/^Mínimo de jugadores/) as HTMLInputElement).value).toBe("2");
        expect(screen.getAllByText("Ponle un nombre").length).toBeGreaterThan(0);
        fireEvent.change(screen.getByLabelText(/^Distancia/), { target: { value: "2000" } });
        await waitFor(() =>
            expect(screen.getAllByText("Como máximo 1000").length).toBeGreaterThan(0)
        );
        expect(screen.queryByText(/At most|Give it a name|events\.problems/)).toBeNull();
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
