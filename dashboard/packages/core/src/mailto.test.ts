/**
 * Reading a `mailto:` link into the composer.
 *
 * The link is written by whoever made the page it is on, so what matters most
 * is that a malformed or hostile one cannot put anything but real addresses in
 * the To line, and that a well-formed one arrives exactly as written.
 */

import { describe, expect, it } from "vitest";
import { parseMailto, plainTextToMarkdown } from "./mailto.js";

describe("an ordinary link", () => {
    it("reads the address, the copies, the subject and the body", () => {
        expect(
            parseMailto(
                "mailto:ana@example.com?cc=bo@example.com&subject=Hola%20Ana&body=Two%0Alines"
            )
        ).toEqual({
            to: ["ana@example.com"],
            cc: ["bo@example.com"],
            bcc: [],
            subject: "Hola Ana",
            body: "Two\nlines"
        });
    });

    it("takes several addresses, in the head and in to=, once each", () => {
        const seed = parseMailto("mailto:a@example.com,B@Example.com?to=a@example.com,c@example.com");
        expect(seed?.to).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    });

    it("keeps a plus sign, which a mailto never uses for a space", () => {
        expect(parseMailto("mailto:a@example.com?subject=C++%20question")?.subject).toBe(
            "C++ question"
        );
    });
});

describe("the body, on its way into the composer", () => {
    it("keeps its lines and its characters rather than reading them as Markdown", () => {
        expect(plainTextToMarkdown("Hi *there*\n# not a heading\n\nNew paragraph")).toBe(
            "Hi \\*there\\*\\\n\\# not a heading\n\nNew paragraph"
        );
        expect(plainTextToMarkdown("1. first\n- item")).toBe("1\\. first\\\n\\- item");
    });
});

describe("a link nobody should trust", () => {
    it("drops what is not an address rather than carrying it into the To line", () => {
        const seed = parseMailto("mailto:not-an-address,ok@example.com?bcc=%3Cscript%3E");
        expect(seed?.to).toEqual(["ok@example.com"]);
        expect(seed?.bcc).toEqual([]);
    });

    it("ignores headers a link has no business setting", () => {
        const seed = parseMailto("mailto:a@example.com?in-reply-to=%3Cx%40y%3E&from=boss@example.com");
        expect(seed).toEqual({ to: ["a@example.com"], cc: [], bcc: [], subject: "", body: "" });
    });

    it("survives a stray percent sign and refuses what is not a mailto at all", () => {
        expect(parseMailto("mailto:a@example.com?subject=50%")?.subject).toBe("50%");
        expect(parseMailto("https://example.com")).toBeNull();
    });
});
