// @vitest-environment jsdom

/**
 * A relative link in a message goes where the message's own <base> says, not
 * to the Polaris page the frame is drawn on (BUG-0020). The <base> itself is
 * still stripped: it is used to resolve links and nothing else.
 */

import { describe, expect, it } from "vitest";
import { messageBase, sanitizeMail } from "@/app/(app)/mail/sanitize";

describe("messageBase", () => {
    it("reads the message's base, quoted or not", () => {
        expect(messageBase(`<head><base href="https://news.example.com/issue/">`)).toBe("https://news.example.com/issue/");
        expect(messageBase(`<base target=_blank href='http://a.example/'>`)).toBe("http://a.example/");
        expect(messageBase(`<base href=https://b.example/x/>`)).toBe("https://b.example/x/");
    });

    it("ignores a base that is missing, relative or not on the web", () => {
        expect(messageBase(`<p>no base</p>`)).toBeNull();
        expect(messageBase(`<base href="/relative/">`)).toBeNull();
        expect(messageBase(`<base href="javascript:alert(1)">`)).toBeNull();
        expect(messageBase(`<base href="file:///C:/">`)).toBeNull();
    });
});

describe("sanitizeMail with a base", () => {
    it("resolves relative links against it and still strips the base", async () => {
        const html = `<base href="https://news.example.com/issue/7/"><a id="a" href="read?x=1">a</a><a id="b" href="/top">b</a><a id="c" href="#part">c</a><a id="d" href="https://other.example/">d</a><map><area id="e" href="map"></map>`;
        const clean = await sanitizeMail(html);
        const doc = new DOMParser().parseFromString(clean, "text/html");
        expect(doc.querySelector("base")).toBeNull();
        expect(doc.getElementById("a")?.getAttribute("href")).toBe("https://news.example.com/issue/7/read?x=1");
        expect(doc.getElementById("b")?.getAttribute("href")).toBe("https://news.example.com/top");
        expect(doc.getElementById("c")?.getAttribute("href")).toBe("#part");
        expect(doc.getElementById("d")?.getAttribute("href")).toBe("https://other.example/");
        expect(doc.getElementById("e")?.getAttribute("href")).toBe("https://news.example.com/issue/7/map");
    });

    it("leaves relative links alone with no base, and is idempotent", async () => {
        const clean = await sanitizeMail(`<a id="a" href="read">a</a>`);
        expect(new DOMParser().parseFromString(clean, "text/html").getElementById("a")?.getAttribute("href")).toBe("read");
        expect(await sanitizeMail(clean)).toBe(clean);
    });

    it("does not resolve the next message against the last one's base", async () => {
        await sanitizeMail(`<base href="https://first.example/"><a href="x">x</a>`);
        const clean = await sanitizeMail(`<a id="a" href="y">y</a><i>second</i>`);
        expect(new DOMParser().parseFromString(clean, "text/html").getElementById("a")?.getAttribute("href")).toBe("y");
    });
});
