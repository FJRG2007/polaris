import { describe, expect, it } from "vitest";
import {
    parseArkProfile,
    parseProfileDump,
    readProfileDataId,
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

/** The number the game's own admin commands take, which is nowhere else but here. */
function dataId(value: bigint): Buffer {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(value, 0);
    return property("PlayerDataID", "UInt64Property", bytes);
}

describe("readProfileDataId", () => {
    it("reads the id the game knows them by", () => {
        expect(readProfileDataId(Buffer.concat([NOISE, dataId(1_234_567_890n)]))).toBe("1234567890");
    });

    it("keeps every digit of one too wide for a number", () => {
        // Sixty-four bits wide, and a float would round the end off it - which is
        // an admin command aimed at nobody.
        expect(readProfileDataId(Buffer.concat([NOISE, dataId(18_446_744_073_709_551_615n)]))).toBe(
            "18446744073709551615"
        );
    });

    it("reads an unwritten field as no id rather than as player zero", () => {
        expect(readProfileDataId(Buffer.concat([NOISE, dataId(0n)]))).toBeNull();
    });

    it("is not fooled by the field that merely ends with the same word", () => {
        const decoy = property("LinkedPlayerDataID", "UInt64Property", Buffer.alloc(8, 9));
        expect(readProfileDataId(Buffer.concat([decoy, dataId(42n)]))).toBe("42");
    });

    it("says nothing for a file that does not carry one", () => {
        expect(readProfileDataId(NOISE)).toBeNull();
    });
});

describe("parseArkProfile", () => {
    it("reads all three, in any order", () => {
        expect(
            parseArkProfile(Buffer.concat([level(11), NOISE, survivorName("Ada"), dataId(7n)]))
        ).toEqual({
            characterName: "Ada",
            level: 12,
            dataId: "7"
        });
    });

    it("reads a file it understands none of as knowing nothing", () => {
        expect(parseArkProfile(Buffer.from("not an ark profile at all"))).toEqual({
            characterName: null,
            level: null,
            dataId: null
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

describe("parseProfileDump", () => {
    /** What the read hands back: a header per player, one line of base64 under it,
     *  and a last line saying where the files were. */
    const dump = (entries: [string, Buffer][], directory?: string) =>
        [
            ...entries.flatMap(([id, bytes]) => [`== ${id}`, bytes.toString("base64")]),
            ...(directory ? [`@@ ${directory}`] : [])
        ].join("\n");

    it("reads several survivors out of one read", () => {
        const output = dump([
            ["76561198000000001", Buffer.concat([NOISE, level(9), dataId(11n)])],
            ["76561198000000002", Buffer.concat([NOISE, survivorName("Grace")])]
        ]);
        expect(parseProfileDump(output)).toEqual({
            "76561198000000001": { characterName: null, level: 10, dataId: "11" },
            "76561198000000002": { characterName: "Grace", level: null, dataId: null }
        });
    });

    it("ignores the line saying where the files are", () => {
        // It is there for the caller, which remembers it so the next read is a
        // file it can name rather than a search of the whole world folder.
        const output = dump(
            [["76561198000000001", Buffer.concat([NOISE, level(0)])]],
            "/app/server/ShooterGame/Saved/SavedArks"
        );
        expect(Object.keys(parseProfileDump(output))).toEqual(["76561198000000001"]);
    });

    it("skips whatever else the shell printed", () => {
        const output = ["find: permission denied", "== 76561198000000001", "not base64 at all", "@@ /x"].join("\n");
        expect(parseProfileDump(output)).toEqual({});
    });
});
