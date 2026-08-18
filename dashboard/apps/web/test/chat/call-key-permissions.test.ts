/**
 * Who may read the key file, asserted against a filesystem that answers rather
 * than against this machine's.
 *
 * The real bits are checked in `call-keys.test.ts`, and only where they exist:
 * Windows has none, and Node ignores the mode there. What is at stake is worth
 * a test that runs everywhere, because the failure is silent and total - LiveKit
 * refuses a key file the world can read and will not start, and a file that is
 * already a valid pair is never rewritten, so nothing repairs it afterwards.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The one file on this filesystem, with the bits it carries. */
let file: { content: string; mode: number } | null = null;
const chmods: number[] = [];

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));

function fail(code: string): NodeJS.ErrnoException {
    const error = new Error(code) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

vi.mock("node:fs/promises", () => ({
    readFile: async () => {
        if (!file) throw fail("ENOENT");
        return file.content;
    },
    // The mode goes to open(2), which applies it only to a file it creates -
    // which is the whole reason the code cannot rely on it.
    writeFile: async (_path: string, data: string, options: { mode: number; flag: string }) => {
        if (file && options.flag === "wx") throw fail("EEXIST");
        file = { content: data, mode: file ? file.mode : options.mode };
    },
    stat: async () => {
        if (!file) throw fail("ENOENT");
        return { mode: file.mode };
    },
    chmod: async (_path: string, mode: number) => {
        chmods.push(mode);
        if (file) file.mode = mode;
    }
}));

const { CALL_API_KEY, ensureCallKey, forgetCallKey } = await import("@/lib/chat/call-keys");

beforeEach(() => {
    file = null;
    chmods.length = 0;
    forgetCallKey();
});

describe("the key file's permissions", () => {
    it("takes the world's bits off a file it had to replace", async () => {
        file = { content: "not a key file\n", mode: 0o644 };

        expect((await ensureCallKey())?.apiKey).toBe(CALL_API_KEY);
        expect(file!.mode).toBe(0o600);
    });

    it("takes them off a pair it only read", async () => {
        // Never rewritten, so the write path would never have repaired it: a
        // volume seeded by hand or restored from a backup stays as it came.
        file = { content: '"polaris": "seeded-by-somebody-else"\n', mode: 0o644 };

        expect((await ensureCallKey())?.apiSecret).toBe("seeded-by-somebody-else");
        expect(file!.mode).toBe(0o600);
    });

    it("leaves one it created itself alone", async () => {
        // Created with the mode already, so there is nothing to change - and
        // asking to change it on a file owned by somebody else is an error in
        // the log of an install where nothing is wrong.
        await ensureCallKey();

        expect(file?.mode).toBe(0o600);
        expect(chmods).toEqual([]);
    });
});
