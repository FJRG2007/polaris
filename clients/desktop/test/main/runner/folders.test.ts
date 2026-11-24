import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { FOLDERS_MOST, Folders, addFolder, parseFolders, removeFolder } from "@/main/runner/folders";

const A = resolve("/work/a");
const B = resolve("/work/b");

describe("runner folders", () => {
    it("keeps chosen folders absolute, once, newest first and bounded", () => {
        expect(addFolder([], "relative/path")).toEqual([]);
        expect(addFolder([A], B)).toEqual([B, A]);
        expect(addFolder([B, A], join(A, "."))).toEqual([A, B]);
        const many = Array.from({ length: FOLDERS_MOST + 5 }, (_, index) => resolve(`/work/${index}`)).reduce(addFolder, [] as string[]);
        expect(many).toHaveLength(FOLDERS_MOST);
        expect(removeFolder([A, B], A)).toEqual([B]);
    });

    it("reads anything unreadable as no folders", () => {
        expect(parseFolders(null)).toEqual({});
        expect(parseFolders("not json")).toEqual({});
        expect(parseFolders(JSON.stringify({ s: "nope" }))).toEqual({});
    });

    it("stores folders per server and lists them for the server in use", async () => {
        let stored: string | null = null;
        const folders = new Folders({ read: async () => stored, write: async (json) => void (stored = json) });
        await folders.load();
        await folders.add("https://one.example", A);
        expect(folders.list("https://one.example")).toEqual([A]);
        expect(folders.list("https://two.example")).toEqual([]);
        expect(folders.list(null)).toEqual([]);
        const again = new Folders({ read: async () => stored, write: async () => undefined });
        await again.load();
        expect(again.list("https://one.example")).toEqual([A]);
        await folders.remove("https://one.example", A);
        expect(folders.list("https://one.example")).toEqual([]);
    });
});
