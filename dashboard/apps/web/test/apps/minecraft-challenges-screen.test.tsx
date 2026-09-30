// @vitest-environment jsdom

/**
 * The Challenges tab, used the way an operator would: its sections are there
 * before the server answers, a challenge explains itself, the players are
 * listed, a change is saved, and a Spanish account reads it in Spanish.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let answerRead: (value: unknown) => void = () => undefined;
const saved: unknown[] = [];
let locale = "en-US";

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        confirmDialog: { useConfirm: () => [async () => true, null] },
        i18nProvider: { useLocale: () => locale },
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

const settingsModule = await import(
    "@polaris-app/game-servers/src/lib/minecraft/challenges/settings"
);
const settings = settingsModule.settingsSchema.parse({ enabled: true });
const now = Date.now();
const view = {
    settings,
    running: true,
    version: "1.21.4",
    daily: {
        key: "2026-09-29",
        endsAt: now + 5 * 3_600_000,
        refused: [],
        entries: [
            { template: "F4", variant: null, tier: "easy", target: 16, dealt: 2, done: 1 },
            { template: "C2", variant: "spider", tier: "hard", target: 60, dealt: 1, done: 0 }
        ]
    },
    weekly: null,
    card: null,
    tomorrow: [{ template: "E1", variant: null, tier: "easy", target: 200_000 }],
    season: { number: 1, startDay: "2026-09-01", endDay: "2026-10-12", daysLeft: 14 },
    goals: [],
    players: [
        {
            name: "Alba",
            lastSeenAt: now,
            minutes: 90,
            daily: [
                {
                    template: "F4",
                    variant: null,
                    tier: "easy",
                    target: 16,
                    progress: 16,
                    done: true,
                    voided: false
                }
            ],
            weekly: [],
            backlog: [],
            cardDone: 2,
            lines: 0,
            points: 140,
            tier: 1,
            streak: 3,
            titles: []
        }
    ],
    pace: {},
    seasons: [],
    waiting: 0,
    refusal: null
};

vi.mock("@polaris-app/game-servers/src/screens/installed/challenges-actions", () => ({
    readChallengesAction: () =>
        new Promise((resolve) => {
            answerRead = resolve;
        }),
    saveChallengesAction: async (input: { settings: unknown }) => {
        saved.push(input.settings);
        return { view };
    },
    resetChallengePlayerAction: async () => ({ view })
}));

const { MinecraftChallenges } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-challenges"
);
const ID = "00000000-0000-4000-8000-000000000001";

afterEach(() => {
    cleanup();
    saved.length = 0;
    locale = "en-US";
    // The part last opened is remembered per browser; every test starts on the summary.
    globalThis.localStorage?.clear();
});

describe("the Challenges tab", () => {
    it("draws its sections before the server answers", () => {
        render(<MinecraftChallenges installedAppId={ID} canManage />);
        expect(screen.getByText("Challenges")).toBeTruthy();
        // The summary opens first; every other part is one press away.
        expect(screen.getByText("Season and bingo")).toBeTruthy();
        for (const part of ["Summary", "Players", "Community", "Settings", "Rewards", "Catalogue"]) {
            expect(screen.getByText(part)).toBeTruthy();
        }
        expect(screen.getByText("Today's challenges")).toBeTruthy();
        expect(screen.queryByText("Challenges on offer")).toBeNull();
        expect(screen.queryByText("Alba")).toBeNull();
    });

    it("shows today's draw and explains a challenge from its row", async () => {
        render(<MinecraftChallenges installedAppId={ID} canManage />);
        answerRead({ view });
        await waitFor(() =>
            expect(screen.getByText("Harvest 16 pumpkins and melons")).toBeTruthy()
        );
        expect(screen.getByText("Hunt 60 spiders")).toBeTruthy();
        expect(screen.getByText("1 of 2")).toBeTruthy();
        fireEvent.click(screen.getByLabelText("What Harvest 16 pumpkins and melons is"));
        expect(screen.getByText(/Placing a pumpkin and breaking it again nets zero/)).toBeTruthy();
    });

    it("lists the players with where they stand", async () => {
        render(<MinecraftChallenges installedAppId={ID} canManage />);
        fireEvent.click(screen.getByText("Players"));
        answerRead({ view });
        await waitFor(() => expect(screen.getAllByText("Alba").length).toBeGreaterThan(0));
        expect(screen.getByText("2/9")).toBeTruthy();
        expect(screen.getByLabelText("Deal Alba new challenges")).toBeTruthy();
    });

    it("saves the on/off switch the moment it is pressed", async () => {
        // It used to change only the draft: the badge beside it kept reading
        // Off, and a reload undid it for anybody who never found Save below.
        render(<MinecraftChallenges installedAppId={ID} canManage />);
        answerRead({ view });
        await waitFor(() => expect(screen.getByLabelText("Challenges on")).toBeTruthy());
        expect(screen.queryByText("Save")).toBeNull();
        fireEvent.click(screen.getByLabelText("Challenges on"));
        await waitFor(() => expect(saved).toHaveLength(1));
        expect((saved[0] as { enabled: boolean }).enabled).toBe(false);
        expect(screen.queryByText("Save")).toBeNull();
    });

    it("puts the switch back and says why when the save is refused", async () => {
        render(<MinecraftChallenges installedAppId={ID} canManage />);
        answerRead({ view });
        const actions = await import("@polaris-app/game-servers/src/screens/installed/challenges-actions");
        const spy = vi
            .spyOn(actions, "saveChallengesAction")
            .mockResolvedValueOnce({ error: "The challenges could not be saved" } as never);
        const toggle = (await screen.findByLabelText("Challenges on")) as HTMLInputElement;
        const before = toggle.getAttribute("aria-checked") ?? String(toggle.checked);
        fireEvent.click(toggle);
        await waitFor(() => expect(screen.getByText("The challenges could not be saved")).toBeTruthy());
        const after = screen.getByLabelText("Challenges on");
        expect(after.getAttribute("aria-checked") ?? String((after as HTMLInputElement).checked)).toBe(before);
        spy.mockRestore();
    });

    it("puts the switch back and says so when the save never arrives", async () => {
        render(<MinecraftChallenges installedAppId={ID} canManage />);
        answerRead({ view });
        const actions = await import("@polaris-app/game-servers/src/screens/installed/challenges-actions");
        const spy = vi
            .spyOn(actions, "saveChallengesAction")
            .mockRejectedValueOnce(new Error("Failed to fetch"));
        const toggle = (await screen.findByLabelText("Challenges on")) as HTMLInputElement;
        const before = toggle.getAttribute("aria-checked") ?? String(toggle.checked);
        fireEvent.click(toggle);
        await waitFor(() => expect(screen.getByText("The challenges could not be saved")).toBeTruthy());
        const after = screen.getByLabelText("Challenges on");
        expect(after.getAttribute("aria-checked") ?? String((after as HTMLInputElement).checked)).toBe(before);
        spy.mockRestore();
    });

    it("explains every challenge in the catalogue", async () => {
        render(<MinecraftChallenges installedAppId={ID} canManage />);
        fireEvent.click(screen.getByText("Catalogue"));
        answerRead({ view });
        await waitFor(() => expect(screen.getByText("Mining")).toBeTruthy());
        fireEvent.click(screen.getByText("Mining"));
        fireEvent.click(screen.getByLabelText("What Mine 96 ore blocks is"));
        expect(screen.getByText(/placed ore is taken off/i)).toBeTruthy();
    });

    it("reads in Spanish for an account that reads Spanish", async () => {
        locale = "es-ES";
        render(<MinecraftChallenges installedAppId={ID} canManage />);
        answerRead({ view });
        await waitFor(() => expect(screen.getByText("Retos")).toBeTruthy());
        expect(screen.getByText("Temporada y bingo")).toBeTruthy();
        await waitFor(() =>
            expect(screen.getByText("Cosecha 16 calabazas y sandías")).toBeTruthy()
        );
        expect(screen.getByText("Versión del servidor: 1.21.4")).toBeTruthy();
        expect(screen.getByText("1 de 2")).toBeTruthy();
        expect(screen.getByText("Retos de hoy")).toBeTruthy();
        // The week's day is chosen under Ajustes, in the reader's words.
        fireEvent.click(screen.getByText("Ajustes"));
        expect(screen.getAllByText("lunes").length).toBeGreaterThan(0);
        expect(screen.getByText("Idioma y horario")).toBeTruthy();
    });

    it("says why a Bedrock server cannot run them, and changes nothing there", async () => {
        render(<MinecraftChallenges installedAppId={ID} canManage />);
        answerRead({ view: { ...view, refusal: "bedrock" } });
        await waitFor(() =>
            expect(screen.getByText(/Bedrock has no scoreboard statistics/)).toBeTruthy()
        );
        expect((screen.getByLabelText("Challenges on") as HTMLButtonElement).disabled).toBe(true);
    });

    it("refuses a time zone nobody can compute in, in words, before saving", async () => {
        render(<MinecraftChallenges installedAppId={ID} canManage />);
        fireEvent.click(screen.getByText("Settings"));
        answerRead({ view });
        const zone = await screen.findByDisplayValue("UTC");
        fireEvent.change(zone, { target: { value: "Mars/Olympus" } });
        expect(await screen.findByText(/That time zone is not one Polaris knows/)).toBeTruthy();
        const save = screen.getByText("Save").closest("button") as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        fireEvent.change(zone, { target: { value: "Europe/Madrid" } });
        await waitFor(() =>
            expect(screen.queryByText(/That time zone is not one Polaris knows/)).toBeNull()
        );
    });

    it("lets somebody without the console look but not change anything", async () => {
        render(<MinecraftChallenges installedAppId={ID} canManage={false} />);
        answerRead({ view });
        await waitFor(() =>
            expect(screen.getByText(/changing them needs the console permission/)).toBeTruthy()
        );
        expect((screen.getByLabelText("Challenges on") as HTMLButtonElement).disabled).toBe(true);
    });
});
