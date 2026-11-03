/**
 * A file is what its bytes say, whatever its name or declared type.
 */

import { describe, expect, it } from "vitest";
import { sniffAudio, sniffDocument, sniffImage } from "@polaris-app/translate/src/model/media";

const bytes = (...values: (number | string)[]) =>
    new Uint8Array(
        values.flatMap((value) =>
            typeof value === "string" ? [...value].map((char) => char.charCodeAt(0)) : [value]
        )
    );

describe("sniffing", () => {
    it("knows pictures by their signature", () => {
        expect(sniffImage(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
        expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
        expect(sniffImage(bytes("RIFF", 0, 0, 0, 0, "WEBP"))).toBe("image/webp");
        expect(sniffImage(bytes("<svg"))).toBeNull();
    });

    it("knows recordings by their signature", () => {
        expect(sniffAudio(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe("audio/webm");
        expect(sniffAudio(bytes("OggS"))).toBe("audio/ogg");
        expect(sniffAudio(bytes("RIFF", 0, 0, 0, 0, "WAVE"))).toBe("audio/wav");
        expect(sniffAudio(bytes("ID3"))).toBe("audio/mpeg");
        expect(sniffAudio(bytes(0, 0, 0, 0x20, "ftypM4A "))).toBe("audio/mp4");
        expect(sniffAudio(bytes("MZ"))).toBeNull();
    });

    it("tells a zip, a PDF and plain text from a binary", () => {
        expect(sniffDocument(bytes("PK", 3, 4))).toBe("zip");
        expect(sniffDocument(bytes("%PDF-1.7"))).toBe("pdf");
        expect(sniffDocument(new TextEncoder().encode("Hola, ¿qué tal?"))).toBe("text");
        expect(sniffDocument(bytes("MZ", 0, 0x90))).toBeNull();
    });
});
