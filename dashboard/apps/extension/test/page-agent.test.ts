// @vitest-environment jsdom
/**
 * What Polar sees of a page and what it may do there: refs from a snapshot,
 * readable text, and password boxes that are never read or typed into.
 */

import { describe, expect, it } from "vitest";
import { RefTable, clickRef, readText, snapshot, typeRef } from "../src/lib/page-agent";

function page(html: string): Document {
    document.body.innerHTML = html;
    return document;
}

describe("the snapshot", () => {
    it("names links, buttons and boxes with refs", () => {
        const doc = page(`
            <a href="https://github.com/acme/app/pulls">Pull requests</a>
            <button>Merge</button>
            <label for="q">Search</label><input id="q" value="bug">
            <input type="hidden" value="csrf-token">
        `);
        const found = snapshot(doc, new RefTable());
        expect(found.map((entry) => [entry.role, entry.name])).toEqual([
            ["link", "Pull requests"],
            ["button", "Merge"],
            ["textbox", "Search"]
        ]);
        expect(found[0]?.href).toBe("https://github.com/acme/app/pulls");
        expect(found[2]?.value).toBe("bug");
        expect(found.every((entry) => /^e\d+$/.test(entry.ref))).toBe(true);
    });

    it("never carries a password box's value", () => {
        const doc = page(`<input type="password" aria-label="Password" value="hunter2">
            <input autocomplete="current-password" aria-label="PIN" value="1234">`);
        const found = snapshot(doc, new RefTable());
        expect(found).toHaveLength(2);
        expect(found.every((entry) => entry.password === true && entry.value === undefined)).toBe(
            true
        );
        expect(JSON.stringify(found)).not.toMatch(/hunter2|1234/);
    });

    it("narrows by a query", () => {
        const doc = page("<button>Merge</button><button>Close</button>");
        expect(snapshot(doc, new RefTable(), "merge").map((entry) => entry.name)).toEqual([
            "Merge"
        ]);
    });
});

describe("reading", () => {
    it("reads headings, paragraphs, lists and links as Markdown, without scripts", () => {
        const doc =
            page(`<h1>acme/app</h1><p>A tool. See <a href="https://acme.test/docs">docs</a>.</p>
            <ul><li>one</li><li>two</li></ul><script>window.secret = 1</script>
            <div hidden>not shown</div>`);
        const read = readText(doc)!;
        expect(read.text).toContain("# acme/app");
        expect(read.text).toContain("[docs](https://acme.test/docs)");
        expect(read.text).toContain("- one");
        expect(read.text).not.toContain("secret");
        expect(read.text).not.toContain("not shown");
    });

    it("shows that a password box is there, never what it holds", () => {
        const doc = page('<form><p>Sign in <input type="password" value="hunter2"></p></form>');
        const read = readText(doc)!;
        expect(read.text).toContain("[password box]");
        expect(read.text).not.toContain("hunter2");
    });

    it("is bounded", () => {
        const doc = page(`<p>${"word ".repeat(20_000)}</p>`);
        const read = readText(doc)!;
        expect(read.truncated).toBe(true);
        expect(read.text.length).toBeLessThanOrEqual(30_000);
    });

    it("answers null for a selector that matches nothing or is not one", () => {
        const doc = page("<p>x</p>");
        expect(readText(doc, "#missing")).toBeNull();
        expect(readText(doc, "))")).toBeNull();
    });
});

describe("acting", () => {
    it("clicks and types only by a ref it handed out", () => {
        const doc = page('<button>Go</button><input aria-label="Name">');
        const refs = new RefTable();
        let clicked = 0;
        doc.querySelector("button")!.addEventListener("click", () => clicked++);
        const [button, box] = snapshot(doc, refs);
        expect(clickRef(refs, button!.ref)).toEqual({ ok: true });
        expect(clicked).toBe(1);
        expect(typeRef(refs, box!.ref, "Ada")).toEqual({ ok: true });
        expect((doc.querySelector("input") as HTMLInputElement).value).toBe("Ada");
        expect(clickRef(refs, "e999")).toEqual({ ok: false, refusal: "unknown-ref" });
    });

    it("refuses to type into a password box", () => {
        const doc = page('<input type="password" aria-label="Password">');
        const refs = new RefTable();
        const [box] = snapshot(doc, refs);
        expect(typeRef(refs, box!.ref, "guess")).toEqual({ ok: false, refusal: "password-field" });
        expect((doc.querySelector("input") as HTMLInputElement).value).toBe("");
    });

    it("forgets a ref whose element left the page", () => {
        const doc = page("<button>Go</button>");
        const refs = new RefTable();
        const [button] = snapshot(doc, refs);
        doc.body.innerHTML = "";
        expect(clickRef(refs, button!.ref)).toEqual({ ok: false, refusal: "unknown-ref" });
    });
});
