// @vitest-environment jsdom

/**
 * The Ranks tab, as the person editing it meets it.
 *
 * The tab is a draft the server only sees on Save: a rank is created, given a
 * tag and players, moved and deleted without a command reaching the game, and a
 * save that would remove a team Polaris did not make says which ones first, in
 * the page's own dialog rather than the browser's. A Bedrock server gets the
 * reason it has no ranks instead of controls that would fail.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Answer = { view?: unknown; error?: string };

let readAnswer: () => Promise<Answer> = async () => ({ view: view([]) });
const saved = vi.fn();
const confirmed = vi.fn();
let importAnswer: () => Promise<{ ranks?: unknown[]; error?: string }> = async () => ({
    ranks: []
});

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        liveRead: { useKeptSnapshot: () => undefined },
        snapshotCache: {
            readSnapshot: () => null,
            writeSnapshot: () => undefined,
            dropSnapshots: () => undefined
        },
        confirmDialog: {
            useConfirm: () => [
                async (options: unknown) => {
                    confirmed(options);
                    return true;
                },
                null
            ]
        },
        i18nProvider: { useLocale: () => "en-US" }
    }
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/ranks-actions", () => ({
    readRanksAction: () => readAnswer(),
    importRanksAction: () => importAnswer(),
    saveRanksAction: async (input: { ranks: unknown[] }) => {
        saved(input);
        return { saved: { ranks: input.ranks, applied: true, refused: 0 } };
    }
}));

type Rank = import("@polaris-app/game-servers/src/lib/minecraft/ranks").Rank;

const { MinecraftRanks, named } =
    await import("@polaris-app/game-servers/src/screens/installed/minecraft-ranks");

const ID = "00000000-0000-4000-8000-000000000001";

function view(ranks: unknown[], edition = "java") {
    return {
        ranks,
        edition,
        players: [
            { name: "Steve", online: true },
            { name: "Alex", online: false }
        ]
    };
}

const ADMIN: Rank = {
    id: "admin",
    name: "Admin",
    tag: "ADMIN",
    symbol: "",
    color: "red",
    bold: true,
    players: ["Steve"]
};
const VIP: Rank = {
    ...ADMIN,
    id: "vip",
    name: "VIP",
    tag: "VIP",
    color: "gold",
    bold: false,
    players: []
};

afterEach(() => {
    cleanup();
    saved.mockClear();
    confirmed.mockClear();
    readAnswer = async () => ({ view: view([]) });
    importAnswer = async () => ({ ranks: [] });
});

describe("before and around the server's answer", () => {
    it("draws the heading at once and a placeholder only where the list goes", () => {
        readAnswer = () => new Promise(() => undefined);
        const { container } = render(<MinecraftRanks installedAppId={ID} />);
        expect(screen.getByText("Ranks")).toBeTruthy();
        expect(container.querySelector("[aria-busy=true]")).not.toBeNull();
    });

    it("says there are none yet and how to start", async () => {
        render(<MinecraftRanks installedAppId={ID} />);
        expect(await screen.findByText("No ranks yet")).toBeTruthy();
        expect(screen.getByRole("button", { name: /New rank/ })).toBeTruthy();
        expect(screen.getByRole("button", { name: /Import from server/ })).toBeTruthy();
    });

    it("says the reading failed and offers to try again", async () => {
        readAnswer = async () => ({ error: "Could not load the ranks." });
        render(<MinecraftRanks installedAppId={ID} />);
        expect(await screen.findByText("Could not load the ranks.")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    });

    it("gives a Bedrock server the reason instead of controls", async () => {
        readAnswer = async () => ({ view: view([ADMIN], "bedrock") });
        render(<MinecraftRanks installedAppId={ID} />);
        expect(await screen.findByText(/Bedrock servers have no teams/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: /New rank/ })).toBeNull();
        expect(screen.queryByRole("button", { name: /Import from server/ })).toBeNull();
    });
});

describe("editing the draft", () => {
    it("creates a rank, previews it and saves it named after what it is called", async () => {
        render(<MinecraftRanks installedAppId={ID} />);
        fireEvent.click(await screen.findByRole("button", { name: /New rank/ }));
        const save = screen.getByRole("button", { name: "Save and apply" }) as HTMLButtonElement;
        // Empty fields are incomplete, not wrong: no error under them, Save waits.
        expect(save.disabled).toBe(true);
        expect(screen.queryByText("Required")).toBeNull();
        expect(screen.getByText("Fix the marked ranks to save.")).toBeTruthy();

        const name = screen.getByText("Name").parentElement!.querySelector("input")!;
        fireEvent.change(name, { target: { value: "Moderator" } });
        // The editor stays put while typing: the same input is still in the page.
        expect(name.isConnected).toBe(true);
        fireEvent.change(screen.getByPlaceholderText("VIP"), { target: { value: "MOD" } });
        fireEvent.click(screen.getByRole("button", { name: "★" }));
        fireEvent.click(screen.getByRole("radio", { name: "Dark aqua" }));
        expect(screen.getByText("In chat")).toBeTruthy();
        expect(screen.getByText("In the tab list")).toBeTruthy();
        expect(screen.getAllByText("[MOD]").length).toBeGreaterThan(0);

        fireEvent.click(screen.getByRole("button", { name: /Steve/ }));
        fireEvent.change(screen.getByPlaceholderText("Player name"), {
            target: { value: "bad name" }
        });
        expect(screen.getByText("Not a valid player name")).toBeTruthy();
        fireEvent.change(screen.getByPlaceholderText("Player name"), { target: { value: "Alex" } });
        fireEvent.click(screen.getByRole("button", { name: "Add" }));

        expect(save.disabled).toBe(false);
        fireEvent.click(save);
        await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
        expect(confirmed).not.toHaveBeenCalled();
        expect(saved.mock.calls[0]![0].ranks).toEqual([
            {
                id: "moderator",
                name: "Moderator",
                tag: "MOD",
                symbol: "★",
                color: "dark_aqua",
                bold: false,
                players: ["Steve", "Alex"]
            }
        ]);
        expect(await screen.findByText("Saved and applied.")).toBeTruthy();
    });

    it("moves and deletes ranks in the page's own dialog, then saves the new order", async () => {
        const native = vi.spyOn(window, "confirm");
        readAnswer = async () => ({
            view: view([ADMIN, VIP, { ...VIP, id: "guest", name: "Guest", tag: "G" }])
        });
        render(<MinecraftRanks installedAppId={ID} />);
        fireEvent.click(await screen.findByRole("button", { name: "Move VIP up" }));
        fireEvent.click(screen.getByRole("button", { name: "Delete Guest" }));
        await waitFor(() => expect(confirmed).toHaveBeenCalledTimes(1));
        expect(native).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Save and apply" }));
        await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
        expect(saved.mock.calls[0]![0].ranks.map((rank: { id: string }) => rank.id)).toEqual([
            "vip",
            "admin"
        ]);
        native.mockRestore();
    });

    it("offers no Save for a draft put back the way it was", async () => {
        readAnswer = async () => ({ view: view([ADMIN, VIP]) });
        render(<MinecraftRanks installedAppId={ID} />);
        fireEvent.click(await screen.findByRole("button", { name: "Move VIP up" }));
        expect(screen.getByRole("button", { name: "Save and apply" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Move VIP down" }));
        expect(screen.queryByRole("button", { name: "Save and apply" })).toBeNull();
    });
});

describe("importing the server's teams", () => {
    it("shows each team it would replace, and names them again before saving", async () => {
        importAnswer = async () => ({
            ranks: [
                {
                    ...VIP,
                    id: "staff",
                    name: "staff",
                    tag: "STAFF",
                    players: ["Alex"],
                    source: "staff"
                }
            ]
        });
        render(<MinecraftRanks installedAppId={ID} />);
        fireEvent.click(await screen.findByRole("button", { name: /Import from server/ }));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText(/Replaces team staff/)).toBeTruthy();
        fireEvent.click(within(dialog).getByRole("button", { name: "Add 1 rank" }));
        fireEvent.click(screen.getByRole("button", { name: "Save and apply" }));
        await waitFor(() => expect(confirmed).toHaveBeenCalledTimes(1));
        expect(
            String((confirmed.mock.calls[0]![0] as { description: string }).description)
        ).toContain("staff");
        await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
        expect(saved.mock.calls[0]![0].ranks[0].source).toBe("staff");
    });

    it("says why it could not read them", async () => {
        importAnswer = async () => ({
            error: "Could not read the server's teams. Start the server and try again."
        });
        render(<MinecraftRanks installedAppId={ID} />);
        fireEvent.click(await screen.findByRole("button", { name: /Import from server/ }));
        expect(await screen.findByText(/Start the server and try again/)).toBeTruthy();
    });
});

describe("named", () => {
    it("names new ranks after what they are called and keeps saved ids", () => {
        const draft = [
            { ...ADMIN, id: "rank", name: "Admin" },
            { ...VIP, id: "rank2", name: "Admin" },
            { ...VIP, id: "vip", name: "Renamed" }
        ];
        expect(named(draft, new Set(["vip"])).map((rank) => rank.id)).toEqual([
            "admin",
            "admin2",
            "vip"
        ]);
    });
});
