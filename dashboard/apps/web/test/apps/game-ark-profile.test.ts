import { describe, expect, it } from "vitest";
import {
    parseArkProfile,
    readProfileLevel,
    readProfileName,
    steamIdOfProfileFile
} from "@/lib/apps/ark/profile";

/** Unreal writes a string as its length including the terminator, then the bytes,
 *  then the terminator itself. */
function text(value: string): Buffer {
    const bytes = Buffer.alloc(4 + value.length + 1);
    bytes.writeInt32LE(value.length + 1, 0);
    bytes.write(value, 4, "latin1");
    return bytes;
}

function int32(value: number): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32LE(value, 0);
    return bytes;
}

/** Name, type, size, index, value - the layout every property in these files has. */
function property(name: string, type: string, value: Buffer): Buffer {
    return Buffer.concat([text(name), text(type), int32(value.length), int32(0), value]);
}

function level(gained: number): Buffer {
    const value = Buffer.alloc(2);
    value.writeUInt16LE(gained, 0);
    return property("CharacterStatusComponent_ExtraCharacterLevel", "UInt16Property", value);
}

function survivorName(name: string): Buffer {
    return property("PlayerCharacterName", "StrProperty", text(name));
}

const NOISE = Buffer.from("ShooterGame.PrimalPlayerData\0some other rubbish\0", "latin1");

describe("readProfileLevel", () => {
    it("counts the level they started at, which the file does not store", () => {
        // The file records levels gained, so a survivor who has gained 71 is 72.
        expect(readProfileLevel(Buffer.concat([NOISE, level(71)]))).toBe(72);
    });

    it("reads a survivor who has never levelled as level 1", () => {
        expect(readProfileLevel(Buffer.concat([NOISE, level(0)]))).toBe(1);
    });

    it("says nothing rather than guessing when the file has no such property", () => {
        expect(readProfileLevel(NOISE)).toBeNull();
    });

    it("refuses a property that is not the type it should be", () => {
        const wrong = property("CharacterStatusComponent_ExtraCharacterLevel", "IntProperty", int32(70));
        expect(readProfileLevel(Buffer.concat([NOISE, wrong]))).toBeNull();
    });

    it("is not fooled by the same letters inside somebody's survivor name", () => {
        // A player can call themselves anything, including the name of a property.
        // Only a run preceded by its own length is a property.
        const decoy = survivorName("CharacterStatusComponent_ExtraCharacterLevel");
        expect(readProfileLevel(Buffer.concat([decoy, level(41)]))).toBe(42);
    });

    it("does not walk off the end of a half-written file", () => {
        const whole = Buffer.concat([NOISE, level(20)]);
        expect(readProfileLevel(whole.subarray(0, whole.length - 1))).toBeNull();
    });

    it("refuses a level nothing in the game could produce", () => {
        expect(readProfileLevel(Buffer.concat([NOISE, level(60000)]))).toBeNull();
    });
});

describe("readProfileName", () => {
    it("reads what they called themselves", () => {
        expect(readProfileName(Buffer.concat([NOISE, survivorName("Rex Wrangler")]))).toBe("Rex Wrangler");
    });

    it("says nothing for a file that does not carry one", () => {
        expect(readProfileName(NOISE)).toBeNull();
    });
});

describe("parseArkProfile", () => {
    it("reads both, in either order", () => {
        expect(parseArkProfile(Buffer.concat([level(11), NOISE, survivorName("Ada")]))).toEqual({
            characterName: "Ada",
            level: 12
        });
    });

    it("reads a file it understands none of as knowing nothing", () => {
        expect(parseArkProfile(Buffer.from("not an ark profile at all"))).toEqual({
            characterName: null,
            level: null
        });
    });
});

describe("steamIdOfProfileFile", () => {
    it("takes the id off the file name", () => {
        expect(steamIdOfProfileFile("/app/server/ShooterGame/Saved/76561198012345678.arkprofile")).toBe(
            "76561198012345678"
        );
    });

    it("ignores everything else in the folder", () => {
        expect(steamIdOfProfileFile("/app/server/ShooterGame/Saved/TheIsland.ark")).toBeNull();
        expect(steamIdOfProfileFile("/app/server/ShooterGame/Saved/12345.arktribe")).toBeNull();
    });
});
