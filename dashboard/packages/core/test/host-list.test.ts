import jsQR from "jsqr";
import { encodeQr } from "../src/qr";
import { describe, expect, it } from "vitest";
import {
    encodeHostList,
    HOST_LIST_MAX,
    hostListFile,
    hostListLink,
    mergeHostLists,
    readHostList,
    type PortableHost
} from "../src/host-list";

const HOSTS: PortableHost[] = [
    { origin: "https://polaris.example.com", name: "Casa" },
    { origin: "http://192.168.1.20:3000", name: null },
    { origin: "https://work.example.org", name: "Oficina ñ" }
];

/** What a phone's camera would read off the code, through a real reader. */
function scan(text: string): string | null {
    const modules = encodeQr(text);
    if (!modules) return null;
    const scale = 4;
    const quiet = 4;
    const side = (modules.length + quiet * 2) * scale;
    const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
    modules.forEach((row, y) =>
        row.forEach((dark, x) => {
            if (!dark) return;
            for (let dy = 0; dy < scale; dy++) {
                for (let dx = 0; dx < scale; dx++) {
                    const at = (((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx) * 4;
                    pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
                }
            }
        })
    );
    return jsQR(pixels, side, side)?.data ?? null;
}

describe("a host list on the move", () => {
    it("reads back the same list from its code, its link and its file", () => {
        expect(readHostList(encodeHostList(HOSTS))).toEqual(HOSTS);
        expect(readHostList(hostListLink(HOSTS))).toEqual(HOSTS);
        expect(readHostList(hostListFile(HOSTS))).toEqual(HOSTS);
        expect(readHostList(`  ${encodeHostList(HOSTS)}\n`)).toEqual(HOSTS);
    });

    it("reads an empty list as a list, and anything else as nothing", () => {
        expect(readHostList(encodeHostList([]))).toEqual([]);
        for (const text of ["", "hello", "polaris-hosts:1:@@@", "{}", '{"kind":"other","hosts":[]}', "polaris://hosts?x=1"]) {
            expect(readHostList(text)).toBeNull();
        }
    });

    it("keeps only bare http(s) addresses, once each, and caps names and the list", () => {
        const file = JSON.stringify({
            kind: "polaris-hosts",
            version: 1,
            hosts: [
                { origin: "javascript:alert(1)", name: "x" },
                { origin: "https://user:pw@evil.example", name: "x" },
                { origin: "https://polaris.example.com/path", name: "x" },
                { origin: "ftp://files.example", name: "x" },
                { origin: "https://ok.example", name: `  ${"n".repeat(80)}  ` },
                { origin: "https://ok.example", name: "duplicate" },
                ...Array.from({ length: 80 }, (_, i) => ({ origin: `https://h${i}.example`, name: 7 }))
            ]
        });
        const read = readHostList(file)!;
        expect(read[0]).toEqual({ origin: "https://ok.example", name: "n".repeat(40) });
        expect(read).toHaveLength(HOST_LIST_MAX);
        expect(read.every((one) => one.origin.startsWith("https://"))).toBe(true);
        expect(read[1]!.name).toBeNull();
    });

    it("refuses a text too long to be a list", () => {
        expect(readHostList(`polaris-hosts:1:${"A".repeat(70_000)}`)).toBeNull();
    });

    it("adds what is new, names what was unnamed, and never renames or drops silently", () => {
        const saved: PortableHost[] = [
            { origin: "https://polaris.example.com", name: "Mine" },
            { origin: "http://192.168.1.20:3000", name: null }
        ];
        const incoming: PortableHost[] = [
            { origin: "https://polaris.example.com", name: "Theirs" },
            { origin: "http://192.168.1.20:3000", name: "Lab" },
            { origin: "https://a.example", name: null },
            { origin: "https://b.example", name: null }
        ];
        const merged = mergeHostLists(saved, incoming, 3);
        expect(merged.hosts).toEqual([
            { origin: "https://polaris.example.com", name: "Mine" },
            { origin: "http://192.168.1.20:3000", name: "Lab" },
            { origin: "https://a.example", name: null }
        ]);
        expect(merged).toMatchObject({ added: 1, named: 1, skipped: 1 });
    });
});

describe("the QR a list travels in", () => {
    it("is read back by a camera, short or long", () => {
        const many = Array.from({ length: 20 }, (_, i) => ({ origin: `https://host-${i}.example.com`, name: `Host ${i}` }));
        for (const text of [hostListLink(HOSTS), hostListLink(many), "https://polaris.example.com"]) {
            expect(scan(text)).toBe(text);
        }
    });

    it("says when a text cannot fit any code", () => {
        expect(encodeQr("x".repeat(3000))).toBeNull();
    });
});
