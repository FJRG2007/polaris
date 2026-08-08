import { describe, expect, it } from "vitest";
import { dimensionLabel, formatCoordinates, parseDimension, parsePosition } from "@/lib/apps/minecraft/position";

describe("parsePosition", () => {
    it("reads the three numbers out of the reply", () => {
        const reply = "Alice has the following entity data: [123.456d, 64.0d, -220.5d]";
        expect(parsePosition(reply)).toEqual({ x: 123.456, y: 64, z: -220.5 });
    });

    it("is null when the player is not there, rather than the origin", () => {
        // 0 0 0 is a real place somebody could be standing, so it must never be
        // what "we do not know" looks like.
        expect(parsePosition("No entity was found")).toBeNull();
        expect(parsePosition("")).toBeNull();
    });

    it("is null for a list that is not three numbers", () => {
        expect(parsePosition("Alice has the following entity data: [1.0d, 2.0d]")).toBeNull();
        expect(parsePosition("Alice has the following entity data: [1.0d, 2.0d, 3.0d, 4.0d]")).toBeNull();
        expect(parsePosition("Alice has the following entity data: [1.0d, up, 3.0d]")).toBeNull();
    });

    it("is null when the reply was cut off before the list closed", () => {
        expect(parsePosition("Alice has the following entity data: [123.4d, 64.0d,")).toBeNull();
    });

    it("reads the coordinates past anything the client printed before the reply", () => {
        const reply = [
            "2026/08/08 21:45:30 [WARN] connection reset, retrying",
            "Alice has the following entity data: [1.0d, 2.0d, 3.0d]"
        ].join("\n");
        expect(parsePosition(reply)).toEqual({ x: 1, y: 2, z: 3 });
    });
});

describe("parseDimension", () => {
    it("reads the world out of the reply, past the sentence's own colon", () => {
        const reply = 'Alice has the following entity data: "minecraft:the_nether"';
        expect(parseDimension(reply)).toBe("minecraft:the_nether");
    });

    it("reads a custom dimension too", () => {
        expect(parseDimension('Bob has the following entity data: "aether:the_aether"')).toBe("aether:the_aether");
    });

    it("is null when nothing namespaced came back", () => {
        expect(parseDimension("No entity was found")).toBeNull();
        expect(parseDimension("Alice has the following entity data: 12")).toBeNull();
    });

    it("does not read a clock time in a log line as a world", () => {
        expect(parseDimension("2026/08/08 21:45:30 [WARN] connection reset")).toBeNull();
    });

    it("reads the world past a line the client printed first", () => {
        const reply = [
            "2026/08/08 21:45:30 [WARN] connection reset, retrying",
            'Alice has the following entity data: "minecraft:the_end"'
        ].join("\n");
        expect(parseDimension(reply)).toBe("minecraft:the_end");
    });
});

describe("dimensionLabel", () => {
    it("names the three worlds the game names", () => {
        expect(dimensionLabel("minecraft:overworld")).toBe("Overworld");
        expect(dimensionLabel("minecraft:the_nether")).toBe("The Nether");
        expect(dimensionLabel("minecraft:the_end")).toBe("The End");
    });

    it("leaves a custom dimension its id, which is the name its operator has", () => {
        expect(dimensionLabel("aether:the_aether")).toBe("aether:the_aether");
    });
});

describe("formatCoordinates", () => {
    it("gives the block being stood in, ready to paste into a tp", () => {
        expect(formatCoordinates({ x: 123.456, y: 64, z: -220.5 })).toBe("123 64 -221");
    });

    it("floors rather than rounds, so a negative coordinate names the right block", () => {
        expect(formatCoordinates({ x: -0.5, y: 70.9, z: -1.2 })).toBe("-1 70 -2");
    });
});
