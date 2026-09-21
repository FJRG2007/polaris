/**
 * The two rules behind the picture menu.
 *
 * Both are the kind that look like nothing and misbehave in front of somebody: a
 * link copied on this tab's hostname opens for nobody else on the LAN name the
 * installer wrote, and a download asked for across origins is silently refused
 * by the browser, which navigates to the picture instead. So the menu offers
 * saving only where saving works, and copies an address somebody else can open.
 */

import { describe, expect, it } from "vitest";
import { imageLink, savable, sharable } from "@/components/image-actions";

const BASE = "https://polaris.example";

describe("the address that gets copied", () => {
    it("puts an attachment on the domain Polaris hands out", () => {
        expect(imageLink("/api/chat/attachments/9", BASE)).toBe(
            "https://polaris.example/api/chat/attachments/9"
        );
    });

    it("leaves a picture that already lives elsewhere alone", () => {
        expect(imageLink("https://example.com/cat.png", BASE)).toBe("https://example.com/cat.png");
    });
});

describe("whether Polaris can save it", () => {
    it("can, for anything it serves itself", () => {
        expect(savable("/api/chat/attachments/9")).toBe(true);
    });

    it("cannot, across origins - the browser would navigate instead", () => {
        expect(savable("https://example.com/cat.png")).toBe(false);
    });

    it("cannot, for a protocol-relative address, which is another origin", () => {
        expect(savable("//example.com/cat.png")).toBe(false);
    });
});

describe("whether it is a picture anybody else can reach", () => {
    it("is, for anything with an address behind it", () => {
        expect(sharable("/api/chat/attachments/9")).toBe(true);
        expect(sharable("https://example.com/cat.png")).toBe(true);
    });

    it("is not, for a file staged in the composer and not yet sent", () => {
        // A blob address lives in one tab and dies with the message being sent or
        // the file taken back off, so a copied link to one is a link to nothing.
        expect(sharable("blob:http://localhost:3000/9d1c-4f")).toBe(false);
        expect(sharable("blob:nodedata:9d1c-4f")).toBe(false);
    });
});
