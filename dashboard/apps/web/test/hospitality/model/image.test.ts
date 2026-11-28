/**
 * A stored menu picture is what its bytes say, never what the request says.
 */

import { describe, expect, it } from "vitest";
import { sniffImage } from "@polaris-app/hospitality/src/model/image";

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

describe("sniffImage", () => {
    it("knows WebP, PNG and JPEG by their first bytes", () => {
        expect(sniffImage(new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")]))).toBe("image/webp");
        expect(sniffImage(new Uint8Array([0x89, ...ascii("PNG"), 13, 10, 26, 10]))).toBe("image/png");
        expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    });

    it("refuses anything else, an SVG included", () => {
        expect(sniffImage(new Uint8Array(ascii("<svg xmlns=")))).toBeNull();
        expect(sniffImage(new Uint8Array())).toBeNull();
    });
});
