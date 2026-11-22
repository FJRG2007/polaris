// @vitest-environment jsdom

/**
 * A modded item drawn outside the palette - a player's inventory - asks for its
 * server's catalogue itself, once for the whole bag, so its picture fills in
 * without anyone opening the item picker first.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const { ItemIcon } = await import("@polaris-app/game-servers/src/screens/installed/minecraft-item-icon");
const { ItemServer } = await import("@polaris-app/game-servers/src/screens/installed/minecraft-mod-items");

const SERVER = "11111111-2222-3333-4444-555555555555";

function stubFetch() {
    const fetch = vi.fn(async (url: string) => {
        const body = url.includes("/minecraft/items") ? { items: [], complete: true } : {};
        return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
}

const catalogueCalls = (fetch: ReturnType<typeof stubFetch>) =>
    fetch.mock.calls.filter(([url]) => String(url).includes(`/installed/${SERVER}/minecraft/items`)).length;

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("a modded item's icon", () => {
    it("asks its server's catalogue once, however many slots draw it", async () => {
        const fetch = stubFetch();
        render(
            <ItemServer.Provider value={SERVER}>
                <ItemIcon id="cure:vaccine" />
                <ItemIcon id="cure:syringe" />
                <ItemIcon id="minecraft:stone" />
            </ItemServer.Provider>
        );
        await waitFor(() => expect(catalogueCalls(fetch)).toBe(1));
    });

    it("leaves the catalogue alone for vanilla items and outside a server", async () => {
        const fetch = stubFetch();
        render(
            <>
                <ItemServer.Provider value="99999999-2222-3333-4444-555555555555">
                    <ItemIcon id="minecraft:stone" />
                </ItemServer.Provider>
                <ItemIcon id="cure:vaccine" />
            </>
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(fetch.mock.calls.filter(([url]) => String(url).includes("/minecraft/items")).length).toBe(0);
    });

    it("draws the picture the item's tag picks, and the item's own without one", async () => {
        const server = "22222222-2222-3333-4444-555555555555";
        const build = "b".repeat(40);
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                const body = url.includes("/minecraft/items")
                    ? {
                          complete: true,
                          items: [],
                          variants: [
                              {
                                  item: null,
                                  key: "GunId",
                                  value: "fixture:rifle",
                                  build,
                                  icon: { kind: "mod", name: "fixture.gun.slot.rifle", width: 48, height: 16 }
                              },
                              {
                                  item: "fixture:ammo",
                                  key: "AmmoId",
                                  value: "fixture:round",
                                  build,
                                  icon: { kind: "mod", name: "fixture.ammo.slot.round", width: 16, height: 16 }
                              }
                          ]
                      }
                    : [];
                return new Response(JSON.stringify(body), { status: 200 });
            })
        );
        const { container } = render(
            <ItemServer.Provider value={server}>
                <ItemIcon id="fixture:gun" tag='{GunId:"fixture:rifle",Damage:0}' />
                <ItemIcon id="fixture:ammo" tag='{AmmoId:"fixture:round"}' />
                <ItemIcon id="fixture:ammo_box" tag='{AmmoId:"fixture:round"}' />
            </ItemServer.Provider>
        );
        await waitFor(() => expect(container.querySelectorAll("img").length).toBe(2));
        const sources = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? "");
        expect(sources[0]).toContain("name=fixture.gun.slot.rifle");
        expect(sources[1]).toContain("name=fixture.ammo.slot.round");
        // The box carries an AmmoId too, and is not drawn as a round.
        expect(sources.join(" ")).not.toContain("ammo_box");
    });
});
