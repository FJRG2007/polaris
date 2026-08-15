/**
 * Fetching a picture from an address somebody typed.
 *
 * This backs both a GIF chosen in the picker and one sent by pasting its
 * address, and it replaced a fixed list of allowed hosts. That trade is only
 * sound if the checks below hold: an allowlist refused the whole internet to
 * keep the server off its own network, and what refuses it now is the address
 * check on every hop.
 *
 * The caps matter as much. Without them "send this picture" is a way to make the
 * server hold as much as somebody feels like sending it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let dns = new Map<string, string[]>();
let fetched: string[] = [];
let responses = new Map<string, { status: number; headers: Record<string, string>; body: string }>();

vi.mock("node:dns/promises", () => ({
    lookup: async (hostname: string) => {
        const addresses = dns.get(hostname);
        if (!addresses) throw new Error("not found");
        return addresses.map((address) => ({ address, family: 4 }));
    }
}));

const { fetchImage } = await import("@/lib/safe-fetch");

const CAP = 1024;

beforeEach(() => {
    dns = new Map([
        ["pictures.example", ["93.184.216.34"]],
        ["inside.test", ["10.0.0.5"]],
        ["redirector.test", ["93.184.216.34"]]
    ]);
    fetched = [];
    responses = new Map();

    vi.stubGlobal("fetch", async (input: URL | string) => {
        const address = String(input);
        fetched.push(address);
        const canned = responses.get(address);
        if (!canned) throw new Error("nothing there");
        return new Response(canned.body, { status: canned.status, headers: canned.headers });
    });
});

const picture = (body = "GIF89a", type = "image/gif") => ({
    status: 200,
    headers: { "content-type": type },
    body
});

describe("what comes back", () => {
    it("takes a picture, with the name off the end of the address", async () => {
        responses.set("https://pictures.example/cat.gif", picture());
        const found = await fetchImage("https://pictures.example/cat.gif", CAP);
        expect(found?.contentType).toBe("image/gif");
        expect(found?.name).toBe("cat.gif");
        expect(found?.bytes.length).toBe(6);
    });

    it("has a name for one whose address ends in a slash", async () => {
        responses.set("https://pictures.example/", picture());
        expect((await fetchImage("https://pictures.example/", CAP))?.name).toBe("picture");
    });
});

describe("what it refuses", () => {
    it("refuses a name that resolves inside the network", async () => {
        // The check that replaced the list of allowed hosts. If this ever stops
        // holding, "send this picture" becomes a way to read the LAN.
        responses.set("https://inside.test/x.gif", picture());
        expect(await fetchImage("https://inside.test/x.gif", CAP)).toBeNull();
        expect(fetched).toEqual([]);
    });

    it("refuses a private address written out as one", async () => {
        expect(await fetchImage("http://169.254.169.254/latest/meta-data/", CAP)).toBeNull();
        expect(fetched).toEqual([]);
    });

    it("refuses a redirect from somewhere public to somewhere private", async () => {
        responses.set("https://redirector.test/a.gif", {
            status: 302,
            headers: { location: "https://inside.test/secret.gif" },
            body: ""
        });
        expect(await fetchImage("https://redirector.test/a.gif", CAP)).toBeNull();
        expect(fetched).toEqual(["https://redirector.test/a.gif"]);
    });

    it("refuses anything that is not a picture", async () => {
        responses.set("https://pictures.example/page", picture("<html>", "text/html"));
        expect(await fetchImage("https://pictures.example/page", CAP)).toBeNull();
    });

    it("refuses one that says it is too big", async () => {
        responses.set("https://pictures.example/big.gif", {
            status: 200,
            headers: { "content-type": "image/gif", "content-length": String(CAP * 4) },
            body: "small"
        });
        expect(await fetchImage("https://pictures.example/big.gif", CAP)).toBeNull();
    });

    it("refuses one that is too big without having said so", async () => {
        // A missing or lying content-length is not a reason to hold however much
        // the other end decided to send.
        responses.set("https://pictures.example/liar.gif", picture("x".repeat(CAP + 1)));
        expect(await fetchImage("https://pictures.example/liar.gif", CAP)).toBeNull();
    });

    it("refuses a scheme that is a payload rather than an address", async () => {
        for (const bad of ["data:image/gif;base64,AAAA", "file:///etc/passwd", "not a url", ""]) {
            expect(await fetchImage(bad, CAP)).toBeNull();
        }
        expect(fetched).toEqual([]);
    });

    it("refuses a link carrying credentials", async () => {
        expect(await fetchImage("https://user:secret@pictures.example/x.gif", CAP)).toBeNull();
        expect(fetched).toEqual([]);
    });
});
