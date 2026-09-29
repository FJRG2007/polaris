/**
 * Game-server sanctions on Account standing: a card of their own that exists
 * only while an app that keeps them is installed, drawn apart from Polaris's own
 * restrictions, and said in the reader's language.
 */

import type { ReactNode } from "react";
import { withMessages } from "../setup/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppExtension } from "@/lib/app-extensions/types";

const fake = vi.hoisted(() => ({
    extensions: [] as unknown[],
    installed: true
}));

vi.mock("@/lib/app-extensions/installed", () => ({ installedExtensions: () => fake.extensions }));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: async () => fake.installed }));
vi.mock("@/lib/app-bundles/code", () => ({ withBundleSlot: (slot: unknown) => slot }));
vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "u-ada", name: "Ada" }) }));
vi.mock("@/lib/account-standing-service", () => ({
    accountStandingFor: async () => ({ standing: "good", upheld: 0, since: new Date(0), restrictions: [] })
}));
vi.mock("@/lib/i18n/request", async () => {
    const { translatorFor } = await import("@/lib/i18n/translate");
    return { getTranslations: async (namespace: "account") => translatorFor("en-US", namespace) };
});
vi.mock("@/app/(app)/account/standing/standing-view", () => ({ StandingView: () => null }));
vi.mock("@/components/person-name", () => ({ PlainNames: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/display-format", () => ({
    useDisplayFormat: () => ({ date: (iso: string) => iso, dateTime: (iso: string) => iso })
}));

const registry = await import("@/lib/app-extensions/registry");
const { default: AccountStandingPage } = await import("@/app/(app)/account/standing/page");
const { GameSanctionsList } = await import("@/app/(app)/account/standing/game-sanctions");

const GAMES: AppExtension = {
    id: "game-servers",
    gameSanctions: async () => [
        {
            id: "s1",
            kind: "timeout",
            game: "Minecraft",
            server: "Survival",
            player: "Ada",
            at: new Date("2026-09-29T10:00:00.000Z"),
            until: new Date("2026-09-29T14:00:00.000Z"),
            active: true,
            reason: "Griefing"
        }
    ]
};

beforeEach(() => {
    fake.extensions = [GAMES];
    fake.installed = true;
});

describe("the game sanctions section", () => {
    it("is not there when no app that keeps them is installed", async () => {
        fake.installed = false;
        expect(await registry.offersGameSanctions()).toBe(false);
        expect(await registry.gameSanctionsFor("u-ada")).toEqual({ sanctions: [], incomplete: false });
        const html = renderToStaticMarkup(withMessages(await AccountStandingPage()));
        expect(html).not.toContain("Game server sanctions");
    });

    it("is not there when no installed app offers them", async () => {
        fake.extensions = [{ id: "places" }];
        expect(await registry.offersGameSanctions()).toBe(false);
        const html = renderToStaticMarkup(withMessages(await AccountStandingPage()));
        expect(html).not.toContain("Game server sanctions");
    });

    it("is its own card when Game servers is installed", async () => {
        const html = renderToStaticMarkup(withMessages(await AccountStandingPage()));
        expect(html).toContain("Game server sanctions");
        const { sanctions } = await registry.gameSanctionsFor("u-ada");
        expect(sanctions.map((sanction) => sanction.server)).toEqual(["Survival"]);
    });

    it("says an app that could not answer instead of reading as a clean record", async () => {
        fake.extensions = [{ id: "game-servers", gameSanctions: async () => Promise.reject(new Error("down")) }];
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await registry.gameSanctionsFor("u-ada")).toEqual({ sanctions: [], incomplete: true });
        spy.mockRestore();
    });
});

describe("the list, in Spanish", () => {
    it("names the game, the server, the player and the reason", () => {
        const html = renderToStaticMarkup(
            withMessages(
                <GameSanctionsList
                    incomplete={false}
                    sanctions={[
                        {
                            id: "s1",
                            kind: "timeout",
                            game: "Minecraft",
                            server: "Survival",
                            player: "Ada",
                            at: "2026-09-29T10:00",
                            until: "2026-09-29T14:00",
                            active: true,
                            reason: "Griefing"
                        },
                        {
                            id: "s2",
                            kind: "kick",
                            game: "Minecraft",
                            server: "Survival",
                            player: "Ada",
                            at: "2026-09-20T10:00",
                            until: null,
                            active: false,
                            reason: null
                        }
                    ]}
                />,
                "es-ES"
            )
        );
        expect(html).toContain("Expulsado temporalmente de <span class=\"font-medium\">Survival</span>");
        expect(html).toContain("Expulsado de <span class=\"font-medium\">Survival</span>");
        expect(html).toContain("Como Ada, el 2026-09-29T10:00");
        expect(html).toContain("hasta el 2026-09-29T14:00");
        expect(html).toContain("Motivo: Griefing");
        expect(html).toContain("En vigor");
        expect(html).toContain("Acabada");
        expect(html).toContain("Minecraft");
    });

    it("says there is nothing, in Spanish", () => {
        const html = renderToStaticMarkup(withMessages(<GameSanctionsList incomplete={false} sanctions={[]} />, "es-ES"));
        expect(html).toContain("Ningún servidor de juego ha sancionado");
    });
});
