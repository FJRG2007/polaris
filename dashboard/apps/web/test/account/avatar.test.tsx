/**
 * Profile photos.
 *
 * What is being protected: an uploaded file is whatever its bytes say it is and
 * never what the request claimed, SVG is refused (it is a document that can
 * carry script, and it would be served from Polaris's own origin), the address
 * Gravatar is keyed by is the one it documents, and a face renders its initials
 * whether or not a picture ever arrives.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar, AvatarStack, initials } from "@/components/avatar";
import { gravatarHash, MAX_AVATAR_BYTES, sniffImageMime } from "@/lib/avatar-service";

/** A file with the given first bytes, padded so a signature check has room. */
function withSignature(...signature: number[]): Uint8Array {
    const bytes = new Uint8Array(32);
    bytes.set(signature);
    return bytes;
}

describe("sniffImageMime", () => {
    it("recognises the formats every browser writes", () => {
        expect(sniffImageMime(withSignature(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
        expect(sniffImageMime(withSignature(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
        expect(sniffImageMime(withSignature(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif");
        // RIFF....WEBP
        const webp = withSignature(0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00);
        webp.set([0x57, 0x45, 0x42, 0x50], 8);
        expect(sniffImageMime(webp)).toBe("image/webp");
    });

    it("refuses an SVG however it is dressed up", () => {
        // The dangerous case: a real SVG whose request calls it a PNG. Served
        // back as image/svg+xml from our own origin it would be a script.
        expect(sniffImageMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/>'))).toBeNull();
        expect(sniffImageMime(new TextEncoder().encode("<?xml version=\"1.0\"?><svg/>"))).toBeNull();
    });

    it("refuses anything it does not recognise, rather than guessing", () => {
        expect(sniffImageMime(new Uint8Array())).toBeNull();
        expect(sniffImageMime(withSignature(0x25, 0x50, 0x44, 0x46))).toBeNull();
        expect(sniffImageMime(new TextEncoder().encode("not an image at all"))).toBeNull();
    });

    it("keeps the cap well under anything a page would want to load", () => {
        expect(MAX_AVATAR_BYTES).toBeLessThanOrEqual(2 * 1024 * 1024);
    });
});

describe("gravatarHash", () => {
    // Pinned to a literal digest. Changing how the key is derived (to the legacy
    // MD5, say) would still produce a plausible-looking hex string, and the only
    // symptom would be that nobody is shown the picture they already have.
    it("keys an address by the SHA-256 of it", () => {
        expect(gravatarHash("help@gravatar.com")).toBe(
            "4d8f90ff777d306c85855b55ff9d1a6fbdb2eae15882c096232eb60cca719325"
        );
    });

    it("ignores the case and spacing somebody typed", () => {
        expect(gravatarHash("  Ada@Example.COM ")).toBe(gravatarHash("ada@example.com"));
    });

    it("gives different addresses different keys", () => {
        expect(gravatarHash("ada@example.com")).not.toBe(gravatarHash("grace@example.com"));
    });
});

describe("Avatar", () => {
    it("draws initials under the picture, so nothing flashes empty or broken", () => {
        const markup = renderToStaticMarkup(<Avatar person={{ id: "u1", name: "Ana Ruiz" }} />);
        expect(markup).toContain("AR");
        expect(markup).toContain('src="/api/avatar/u1"');
    });

    it("takes two letters from a single name and gives up honestly on none", () => {
        expect(initials("Prometheus")).toBe("PR");
        expect(initials("   ")).toBe("?");
    });

    it("prefers a picture it was handed over resolving one from the id", () => {
        const markup = renderToStaticMarkup(
            <Avatar person={{ id: "u1", name: "Ana", image: "https://example.test/a.png" }} />
        );
        expect(markup).toContain("https://example.test/a.png");
        expect(markup).not.toContain("/api/avatar/u1");
    });

    it("shows three faces and counts the rest", () => {
        const people = ["Ana", "Bo", "Cy", "Di", "Ed"].map((name, index) => ({ id: `u${index}`, name }));
        const markup = renderToStaticMarkup(<AvatarStack people={people} />);
        expect(markup).toContain("+2");
        expect(markup.match(/<img/g)).toHaveLength(3);
    });

    it("draws nothing at all for nobody", () => {
        expect(renderToStaticMarkup(<AvatarStack people={[]} />)).toBe("");
    });
});
