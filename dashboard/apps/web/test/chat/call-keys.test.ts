/**
 * The key the dashboard and the media server share.
 *
 * It lives on a volume rather than in `.env` because `.env` is written by the
 * installer and an installed Polaris is only ever updated from a button - a key
 * that had to appear there is a key every existing deployment does not have, with
 * no way to get one. So what is asserted here is that the file appears by itself,
 * that it is never replaced once it exists, and that its permissions are ones the
 * media server will accept: it refuses a key file anybody else can read, and the
 * refusal is a container that will not start.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";

const dir = await mkdtemp(join(tmpdir(), "polaris-call-keys-"));

const { CALL_API_KEY, callKeyFile, ensureCallKey, readCallKey } = await import("@/lib/chat/call-keys");

/** A fresh volume for each case: minting once and reading it back afterwards are
 *  two different deployments. */
beforeEach(async () => {
    process.env.POLARIS_CALL_KEYS_DIR = await mkdtemp(join(dir, "run-"));
});

describe("the call server's key", () => {
    it("mints one when there is none", async () => {
        const key = await ensureCallKey();
        expect(key?.apiKey).toBe(CALL_API_KEY);
        // LiveKit logs a secret under 32 characters as an error, and a short one
        // is a signing key worth guessing.
        expect(key!.apiSecret.length).toBeGreaterThanOrEqual(32);
    });

    // Windows has no POSIX permission bits and Node ignores the mode there, so
    // the file always reports 0666 and the assertion would be about the
    // development machine rather than about the code. It runs where it means
    // something, which is also where the container runs.
    it.skipIf(process.platform === "win32")("writes it where only the owner can read it", async () => {
        await ensureCallKey();
        const mode = (await stat(callKeyFile())).mode & 0o777;
        // The check LiveKit actually makes is on the `others` bits, and it is
        // fatal: a key file the world can read is a server that refuses to boot.
        expect(mode & 0o007).toBe(0);
    });

    it("writes it in the shape the media server reads", async () => {
        const key = await ensureCallKey();
        // `name: secret`, which is what `key_file` is parsed as. A shape it
        // cannot read is the same as no key at all.
        expect(await readFile(callKeyFile(), "utf8")).toBe(`${key!.apiKey}: ${key!.apiSecret}\n`);
    });

    it("never replaces one that is already there", async () => {
        const first = await ensureCallKey();
        const second = await ensureCallKey();
        // Replacing it would invalidate every token in flight and leave the
        // media server signing with one secret and the dashboard with another
        // until the container next restarted.
        expect(second).toEqual(first);
    });

    it("adopts the secret an older install was already using", async () => {
        // Before the file existed the pair travelled in .env. Minting a new one
        // on update would change the key of a deployment whose calls worked.
        const key = await ensureCallKey("carried-over-from-the-environment");
        expect(key?.apiSecret).toBe("carried-over-from-the-environment");
    });

    it("ignores the seed once the file exists", async () => {
        const first = await ensureCallKey();
        expect((await ensureCallKey("something-else"))?.apiSecret).toBe(first!.apiSecret);
    });

    it("reads back what it wrote", async () => {
        const key = await ensureCallKey();
        expect(await readCallKey()).toEqual(key);
    });

    it("reads nothing from a file that is not a pair", async () => {
        await writeFile(callKeyFile(), "not a key file\n", "utf8");
        expect(await readCallKey()).toBeNull();
    });

    it("says so rather than throwing when there is no volume", async () => {
        process.env.POLARIS_CALL_KEYS_DIR = join(dir, "no-such-directory");
        // A dev run outside compose. It has no media server either, and the
        // screens say that; an exception here would take the whole page.
        expect(await ensureCallKey()).toBeNull();
    });
});
