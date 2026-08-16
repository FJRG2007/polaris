import { describe, expect, it } from "vitest";
import { isWorkshopImage, parseWorkshopId, workshopUrl } from "@/lib/apps/ark/workshop";
import { formatModIds, isModId, MAX_MODS, movedMod, parseModIds, withMod, withoutMod } from "@/lib/apps/ark/mods";

const ONE = "731604991";
const TWO = "1404697612";
const THREE = "632898827";

describe("parseModIds", () => {
    it("keeps the order the list was written in", () => {
        // ARK loads them in turn and a later one wins, so this is a sequence.
        expect(parseModIds(`${ONE},${TWO},${THREE}`)).toEqual([ONE, TWO, THREE]);
    });

    it("survives a list somebody edited by hand", () => {
        expect(parseModIds(` ${ONE} , ,${TWO},`)).toEqual([ONE, TWO]);
    });

    it("drops anything that is not a Workshop id", () => {
        expect(parseModIds(`${ONE},not-a-mod,12`)).toEqual([ONE]);
    });

    it("names a mod once even when the list has it twice", () => {
        expect(parseModIds(`${ONE},${ONE}`)).toEqual([ONE]);
    });

    it("reads an unset variable as no mods", () => {
        expect(parseModIds(null)).toEqual([]);
        expect(parseModIds("")).toEqual([]);
    });
});

describe("formatModIds", () => {
    it("writes what the image reads", () => {
        expect(formatModIds([ONE, TWO])).toBe(`${ONE},${TWO}`);
    });

    it("round-trips", () => {
        expect(parseModIds(formatModIds([ONE, TWO, THREE]))).toEqual([ONE, TWO, THREE]);
    });
});

describe("withMod", () => {
    it("adds a mod last, where it wins over the ones before it", () => {
        expect(withMod([ONE], TWO)).toEqual([ONE, TWO]);
    });

    it("changes nothing for a mod already on the list", () => {
        expect(withMod([ONE, TWO], ONE)).toEqual([ONE, TWO]);
    });

    it("refuses something that is not an id", () => {
        expect(() => withMod([], "steamcommunity.com")).toThrow();
    });

    it("refuses to grow past the ceiling", () => {
        const full = Array.from({ length: MAX_MODS }, (_, index) => String(100000 + index));
        expect(() => withMod(full, ONE)).toThrow();
    });
});

describe("withoutMod", () => {
    it("takes one off and leaves the order of the rest", () => {
        expect(withoutMod([ONE, TWO, THREE], TWO)).toEqual([ONE, THREE]);
    });
});

describe("movedMod", () => {
    it("moves one earlier", () => {
        expect(movedMod([ONE, TWO, THREE], TWO, -1)).toEqual([TWO, ONE, THREE]);
    });

    it("moves one later", () => {
        expect(movedMod([ONE, TWO, THREE], TWO, 1)).toEqual([ONE, THREE, TWO]);
    });

    it("leaves the ends alone rather than wrapping round", () => {
        expect(movedMod([ONE, TWO], ONE, -1)).toEqual([ONE, TWO]);
        expect(movedMod([ONE, TWO], TWO, 1)).toEqual([ONE, TWO]);
    });

    it("changes nothing for a mod that is not on the list", () => {
        expect(movedMod([ONE], THREE, 1)).toEqual([ONE]);
    });
});

describe("isModId", () => {
    it("takes a Workshop id and nothing else", () => {
        expect(isModId(ONE)).toBe(true);
        expect(isModId("123")).toBe(false);
        expect(isModId("731604991; rm -rf /")).toBe(false);
    });
});

describe("parseWorkshopId", () => {
    it("takes a bare id", () => {
        expect(parseWorkshopId(` ${ONE} `)).toBe(ONE);
    });

    it("takes the link somebody actually has in their clipboard", () => {
        expect(parseWorkshopId("https://steamcommunity.com/sharedfiles/filedetails/?id=632898827")).toBe(
            THREE
        );
    });

    it("takes a link with more than one parameter on it", () => {
        expect(
            parseWorkshopId("https://steamcommunity.com/sharedfiles/filedetails/?l=spanish&id=1404697612")
        ).toBe(TWO);
    });

    it("refuses something with no id in it", () => {
        expect(parseWorkshopId("https://steamcommunity.com/app/346110/workshop/")).toBeNull();
        expect(parseWorkshopId("Awesome SpyGlass")).toBeNull();
    });
});

describe("isWorkshopImage", () => {
    it("takes Steam's own image hosts", () => {
        expect(isWorkshopImage("https://images.steamusercontent.com/ugc/2020/AB.jpg")).toBe(true);
        expect(isWorkshopImage("https://steamuserimages-a.akamaihd.net/ugc/1/2.jpg")).toBe(true);
    });

    it("refuses anywhere else, so this cannot be made to fetch what somebody names", () => {
        expect(isWorkshopImage("https://example.com/x.png")).toBe(false);
        expect(isWorkshopImage("http://images.steamusercontent.com/x.png")).toBe(false);
        expect(isWorkshopImage("https://images.steamusercontent.com.evil.test/x.png")).toBe(false);
        expect(isWorkshopImage(null)).toBe(false);
    });
});

describe("workshopUrl", () => {
    it("points at the mod's own page", () => {
        expect(workshopUrl(ONE)).toBe(`https://steamcommunity.com/sharedfiles/filedetails/?id=${ONE}`);
    });
});
