/**
 * A Steam store link, read off Steam's storefront answer.
 *
 * The fixtures are trimmed copies of real `appdetails` answers fetched on
 * 2026-10-08 (cc=es, l=english): a game on sale, a free one, one at full price,
 * and an id Steam does not know. Only the fields the card reads are kept; the
 * real answers carry dozens more, which the schema ignores.
 */

import { describe, expect, it } from "vitest";
import { readSteamAnswer, steamAppOf, steamDetailsUrl, storedSteamDetails } from "@/lib/chat/steam";

const ON_SALE = {
    "1091500": {
        success: true,
        data: {
            type: "game",
            name: "Cyberpunk 2077",
            steam_appid: 1091500,
            required_age: 18,
            is_free: false,
            short_description:
                "Cyberpunk 2077 is an open-world, action-adventure RPG set in the dark future of Night City.",
            header_image:
                "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1091500/header.jpg",
            developers: ["CD PROJEKT RED"],
            price_overview: {
                currency: "EUR",
                initial: 5999,
                final: 1799,
                discount_percent: 70,
                initial_formatted: "59,99€",
                final_formatted: "17,99€"
            },
            platforms: { windows: true, mac: true, linux: false },
            release_date: { coming_soon: false, date: "9 Dec, 2020" }
        }
    }
};

const FREE = {
    "570": {
        success: true,
        data: {
            type: "game",
            name: "Dota 2",
            is_free: true,
            short_description:
                "Every day, millions of players worldwide enter battle as one of over a hundred Dota heroes.",
            header_image:
                "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/570/header.jpg",
            developers: ["Valve"],
            platforms: { windows: true, mac: true, linux: true },
            release_date: { coming_soon: false, date: "9 Jul, 2013" }
        }
    }
};

const FULL_PRICE = {
    "2358720": {
        success: true,
        data: {
            type: "game",
            name: "Black Myth: Wukong",
            is_free: false,
            short_description: "Black Myth: Wukong is an action RPG rooted in Chinese mythology.",
            header_image:
                "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2358720/header.jpg",
            developers: ["Game Science"],
            price_overview: {
                currency: "EUR",
                initial: 5999,
                final: 5999,
                discount_percent: 0,
                initial_formatted: "",
                final_formatted: "59,99€"
            },
            platforms: { windows: true, mac: false, linux: false },
            release_date: { coming_soon: false, date: "19 Aug, 2024" }
        }
    }
};

describe("which links are a Steam game", () => {
    it("takes a store app page, with or without its slug", () => {
        expect(steamAppOf("https://store.steampowered.com/app/1091500/Cyberpunk_2077/")).toBe(
            "1091500"
        );
        expect(steamAppOf("https://store.steampowered.com/app/570")).toBe("570");
        expect(steamAppOf("http://STORE.steampowered.com/app/570/?snr=1_7_15")).toBe("570");
        expect(steamAppOf("https://store.steampowered.com/agecheck/app/1091500/")).toBe("1091500");
    });

    it("leaves everything else to the ordinary card", () => {
        expect(steamAppOf("https://store.steampowered.com/bundle/1234/")).toBeNull();
        expect(steamAppOf("https://store.steampowered.com/app/abc/")).toBeNull();
        expect(steamAppOf("https://steamcommunity.com/app/570")).toBeNull();
        expect(steamAppOf("https://store.steampowered.com.evil.test/app/570")).toBeNull();
        expect(steamAppOf("not a link")).toBeNull();
    });

    it("asks Steam in the instance's country and language", () => {
        expect(steamDetailsUrl("570", "EUR", "es-ES")).toBe(
            "https://store.steampowered.com/api/appdetails?appids=570&cc=de&l=spanish"
        );
        expect(steamDetailsUrl("570", "USD", "en-US")).toBe(
            "https://store.steampowered.com/api/appdetails?appids=570&cc=us&l=english"
        );
        // Something it has no mapping for still asks something sensible.
        expect(steamDetailsUrl("570", "XXX", "xx-XX")).toBe(
            "https://store.steampowered.com/api/appdetails?appids=570&cc=us&l=english"
        );
    });
});

describe("reading Steam's answer", () => {
    it("keeps the sale: what it costs now, before, and by how much", () => {
        const found = readSteamAnswer("1091500", ON_SALE);
        expect(found?.title).toBe("Cyberpunk 2077");
        expect(found?.author).toBe("CD PROJEKT RED");
        expect(found?.imageUrl).toContain("/apps/1091500/");
        expect(found?.details.price).toEqual({ final: "17,99€", initial: "59,99€", discount: 70 });
        expect(found?.details.free).toBe(false);
        expect(found?.details.releaseDate).toBe("9 Dec, 2020");
        expect(found?.details.platforms).toEqual({ windows: true, mac: true, linux: false });
    });

    it("says free to play and carries no price", () => {
        const found = readSteamAnswer("570", FREE);
        expect(found?.details.free).toBe(true);
        expect(found?.details.price).toBeNull();
        expect(found?.details.platforms.linux).toBe(true);
    });

    it("has no old price when nothing is on sale", () => {
        const found = readSteamAnswer("2358720", FULL_PRICE);
        expect(found?.details.price).toEqual({ final: "59,99€", initial: "", discount: 0 });
    });

    it("reads a game that is not out yet", () => {
        const found = readSteamAnswer("9", {
            "9": {
                success: true,
                data: { name: "Upcoming", release_date: { coming_soon: true, date: "Q1 2027" } }
            }
        });
        expect(found?.details.comingSoon).toBe(true);
        expect(found?.details.releaseDate).toBe("Q1 2027");
        expect(found?.details.price).toBeNull();
        expect(found?.imageUrl).toBeNull();
    });

    it("says nothing about an id Steam does not know, or an answer it cannot read", () => {
        expect(readSteamAnswer("99999999", { "99999999": { success: false } })).toBeNull();
        expect(readSteamAnswer("570", { "1": FREE["570"] })).toBeNull();
        expect(readSteamAnswer("570", "<html>")).toBeNull();
        expect(readSteamAnswer("570", { "570": { success: true, data: { name: 4 } } })).toBeNull();
    });

    it("refuses a picture that is not https", () => {
        const found = readSteamAnswer("570", {
            "570": {
                success: true,
                data: { name: "Dota 2", header_image: "http://example.com/a.jpg" }
            }
        });
        expect(found?.imageUrl).toBeNull();
    });

    it("undoes the HTML escapes in the description", () => {
        const found = readSteamAnswer("570", {
            "570": {
                success: true,
                data: { name: "X", short_description: "Tom &amp; Jerry&#39;s &quot;game&quot;" }
            }
        });
        expect(found?.description).toBe('Tom & Jerry\'s "game"');
    });
});

describe("what is stored", () => {
    it("reads back what was written", () => {
        const details = readSteamAnswer("1091500", ON_SALE)!.details;
        expect(storedSteamDetails(JSON.stringify(details))).toEqual(details);
    });

    it("reads an older or broken row as no details", () => {
        expect(storedSteamDetails(null)).toBeNull();
        expect(storedSteamDetails("{")).toBeNull();
        expect(storedSteamDetails(JSON.stringify({ kind: "steam" }))).toBeNull();
    });
});
