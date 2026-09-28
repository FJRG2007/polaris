/**
 * A folder's zip carries only what the reader may open inside it. The folder
 * itself is authorized by the route; a subfolder denied under it is neither
 * listed in the archive nor descended into.
 */

import { describe, expect, it } from "vitest";
import type { StorageDriver } from "@polaris/storage";
import { zipSourcesFor } from "@/lib/drive-archive";

const AT = new Date("2026-01-01T00:00:00Z");

const TREE: Record<string, Array<{ name: string; path: string; kind: "file" | "dir" }>> = {
    team: [
        { name: "notes.txt", path: "team/notes.txt", kind: "file" },
        { name: "hr", path: "team/hr", kind: "dir" }
    ],
    "team/hr": [{ name: "payroll.xlsx", path: "team/hr/payroll.xlsx", kind: "file" }]
};

const driver = {
    stat: async (path: string) => ({
        path,
        kind: path in TREE ? "dir" : "file",
        size: 1n,
        modifiedAt: AT
    }),
    list: async (path: string) => ({
        entries: (TREE[path] ?? []).map((entry) => ({ ...entry, size: 1n, modifiedAt: AT }))
    }),
    readStream: async () => new ReadableStream<Uint8Array>()
} as unknown as StorageDriver;

async function names(filter?: (path: string) => Promise<boolean>): Promise<string[]> {
    const out: string[] = [];
    for await (const source of zipSourcesFor(driver, ["team"], new Set(), filter))
        out.push(source.name);
    return out;
}

describe("zipSourcesFor", () => {
    it("walks everything when nothing is filtered", async () => {
        expect(await names()).toEqual([
            "team/",
            "team/notes.txt",
            "team/hr/",
            "team/hr/payroll.xlsx"
        ]);
    });

    it("leaves a refused subfolder and its files out", async () => {
        const filter = async (path: string) => !(path === "team/hr" || path.startsWith("team/hr/"));
        expect(await names(filter)).toEqual(["team/", "team/notes.txt"]);
    });
});
