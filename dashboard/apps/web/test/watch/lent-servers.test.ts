/**
 * Watch > Servers for somebody a server was lent to (`place.server`): the lent
 * server is listed beside their own, marked as shared with them; somebody with
 * neither Watch nor a lent server is refused; and the rail offers Servers on the
 * grant alone.
 */

import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    canRead: false,
    lent: [] as { id: string; detail: string }[],
    refused: 0
}));

vi.mock("@/lib/session", () => ({
    requireUser: vi.fn(async () => ({ id: "u1", isAdmin: false })),
    sessionCan: vi.fn(async () => state.canRead),
    requirePermission: vi.fn(async () => {
        state.refused += 1;
        throw new Error("refused");
    })
}));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: vi.fn(async () => (key: string) => key)
}));
vi.mock("@/lib/watch-overview-service", () => ({
    getWatchServers: vi.fn(async () => [{ id: "own", detail: "mine" }])
}));
vi.mock("@/lib/machines/machines-service", () => ({
    lentMachineServers: vi.fn(async (_user: string, label: string) =>
        state.lent.map((card) => ({ ...card, detail: label }))
    )
}));
vi.mock("@/app/(app)/watch/watch-cards", () => ({ WatchCardList: () => null }));

const { default: WatchServersPage } = await import("@/app/(app)/watch/servers/page");
const { sectionOffered, APP_SECTIONS } = await import("@/lib/apps");

/** The cards the page hands its list. */
async function cardsShown(): Promise<{ id: string; detail: string }[]> {
    const page = (await WatchServersPage()) as ReactElement<{ children: ReactElement[] }>;
    const list = page.props.children[1] as ReactElement<{
        cards: { id: string; detail: string }[];
    }>;
    return list.props.cards;
}

describe("Watch > Servers and lent servers", () => {
    beforeEach(() => {
        state.canRead = false;
        state.lent = [];
        state.refused = 0;
    });

    it("lists a lent server beside the reader's own, marked as shared", async () => {
        state.canRead = true;
        state.lent = [{ id: "lent", detail: "" }];
        expect(await cardsShown()).toEqual([
            { id: "own", detail: "mine" },
            { id: "lent", detail: "servers.sharedWithYou" }
        ]);
    });

    it("shows only the lent server to somebody without Watch", async () => {
        state.lent = [{ id: "lent", detail: "" }];
        expect((await cardsShown()).map((card) => card.id)).toEqual(["lent"]);
        expect(state.refused).toBe(0);
    });

    it("refuses somebody with neither, including once the share is taken back", async () => {
        await expect(cardsShown()).rejects.toThrow("refused");
        expect(state.refused).toBe(1);
    });

    it("offers Servers in the rail on the grant alone, and nothing else needing Watch", () => {
        const sections = APP_SECTIONS.watch ?? [];
        const servers = sections.find((one) => one.href === "/watch/servers");
        const gate = { isAdmin: false, held: ["place.server"], installed: [] };
        expect(servers && sectionOffered(servers, gate)).toBe(true);
        const others = sections.filter((one) => one !== servers);
        expect(others.some((one) => sectionOffered(one, gate))).toBe(false);
    });
});
