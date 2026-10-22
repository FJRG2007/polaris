import { describe, expect, it } from "vitest";
import {
    browserAnswer,
    browserCommand,
    browserCommandWrites,
    browserEnvelope,
    browserSiteOf
} from "./browser-agent";

describe("browser agent protocol", () => {
    it("takes the commands it names and nothing else", () => {
        expect(
            browserCommand.safeParse({ kind: "open", url: "https://github.com/a/b" }).success
        ).toBe(true);
        expect(browserCommand.safeParse({ kind: "open", url: "javascript:alert(1)" }).success).toBe(
            false
        );
        expect(browserCommand.safeParse({ kind: "open", url: "file:///etc/passwd" }).success).toBe(
            false
        );
        expect(browserCommand.safeParse({ kind: "eval", code: "1" }).success).toBe(false);
        expect(
            browserCommand.safeParse({ kind: "click", tab: 3, ref: "e4", site: "GitHub.com" })
        ).toMatchObject({
            success: true,
            data: { site: "github.com" }
        });
    });

    it("refuses a ref that is a selector and a site that is an address", () => {
        expect(
            browserCommand.safeParse({ kind: "click", tab: 1, ref: "#login", site: "a.com" })
                .success
        ).toBe(false);
        expect(
            browserCommand.safeParse({ kind: "click", tab: 1, ref: "e1", site: "https://a.com/" })
                .success
        ).toBe(false);
    });

    it("caps what one call types", () => {
        const long = "x".repeat(5000);
        expect(
            browserCommand.safeParse({ kind: "type", tab: 1, ref: "e1", site: "a.com", text: long })
                .success
        ).toBe(false);
    });

    it("checks the envelope and the answer", () => {
        expect(
            browserEnvelope.safeParse({ id: "abcdefgh12", command: { kind: "close", tab: 2 } })
                .success
        ).toBe(true);
        expect(
            browserEnvelope.safeParse({ id: "../x", command: { kind: "close", tab: 2 } }).success
        ).toBe(false);
        expect(
            browserAnswer.safeParse({
                id: "abcdefgh12",
                result: { ok: false, refusal: "site-denied" }
            }).success
        ).toBe(true);
        expect(
            browserAnswer.safeParse({
                id: "abcdefgh12",
                result: { ok: false, refusal: "whatever" }
            }).success
        ).toBe(false);
    });

    it("marks only clicks and typing as writes", () => {
        expect(browserCommandWrites({ kind: "click" })).toBe(true);
        expect(browserCommandWrites({ kind: "type" })).toBe(true);
        expect(browserCommandWrites({ kind: "read" })).toBe(false);
        expect(browserCommandWrites({ kind: "open" })).toBe(false);
    });

    it("names a site by its host", () => {
        expect(browserSiteOf("https://GitHub.com/a/b?x=1")).toBe("github.com");
        expect(browserSiteOf("http://localhost:3000/")).toBe("localhost:3000");
        expect(browserSiteOf("chrome://settings")).toBeNull();
        expect(browserSiteOf("not a url")).toBeNull();
    });
});
