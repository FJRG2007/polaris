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
 *
 * The other half is the deployment that already had a pair. It is adopted rather
 * than replaced, and it is adopted here rather than at a call site, because there
 * are two of those - startup and every request - and the first one runs first.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";

/** What this process was started with. Mutable, because "an install that already
 *  had a pair" and "a fresh one" are two different deployments. */
let env: Record<string, string | undefined> = {};

vi.mock("@polaris/config", () => ({ loadEnv: () => env }));

const dir = await mkdtemp(join(tmpdir(), "polaris-call-keys-"));

const { CALL_API_KEY, callKeyFile, ensureCallKey, forgetCallKey, readCallKey } = await import(
    "@/lib/chat/call-keys"
);

/** A fresh volume for each case: minting once and reading it back afterwards are
 *  two different deployments. */
beforeEach(async () => {
    env = {};
    forgetCallKey();
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
        expect(await readFile(callKeyFile(), "utf8")).toBe(`"${key!.apiKey}": "${key!.apiSecret}"\n`);
    });

    it("quotes a secret YAML would read as something else", async () => {
        // The far side is a real YAML parser: `*x` is an alias there and ` #`
        // starts a comment. Unquoted, both sides believe they hold a key and the
        // media server refuses every token - which looks like nothing at all.
        env = { POLARIS_CALL_SERVER_API_SECRET: "*alias and # not a comment" };
        const key = await ensureCallKey();

        expect(key?.apiSecret).toBe("*alias and # not a comment");
        expect(await readFile(callKeyFile(), "utf8")).toContain('"*alias and # not a comment"');
        forgetCallKey();
        expect(await readCallKey()).toEqual(key);
    });

    it("never replaces one that is already there", async () => {
        const first = await ensureCallKey();
        forgetCallKey();
        const second = await ensureCallKey();
        // Replacing it would invalidate every token in flight and leave the
        // media server signing with one secret and the dashboard with another
        // until the container next restarted.
        expect(second).toEqual(first);
    });

    it("answers a burst of readers without reading the file again", async () => {
        const first = await ensureCallKey();
        // Every screen with a call button asks where calls run, and this is on
        // that path. Without the cache it is a read per render, and on a
        // deployment with no volume a failed write and a log line per render.
        await writeFile(callKeyFile(), '"someone-else": "written-underneath"\n', "utf8");
        expect(await ensureCallKey()).toEqual(first);
    });

    it("adopts the pair an older install was already using", async () => {
        // Before the file existed the pair travelled in .env, and the media
        // server was keyed from those same two lines. Minting a new one on
        // update would change the key of a deployment whose calls worked.
        env = {
            POLARIS_CALL_SERVER_URL: "/livekit",
            POLARIS_CALL_SERVER_API_KEY: "named-by-the-installer",
            POLARIS_CALL_SERVER_API_SECRET: "carried-over-from-the-environment"
        };

        expect(await ensureCallKey()).toEqual({
            apiKey: "named-by-the-installer",
            apiSecret: "carried-over-from-the-environment"
        });
    });

    it("does not adopt the key of a server somebody else runs", async () => {
        // A whole address is another house's media server, and that is their
        // signing key. It has no business on this volume, and the server this
        // stack starts gets one of its own.
        env = {
            POLARIS_CALL_SERVER_URL: "wss://calls.example.com",
            POLARIS_CALL_SERVER_API_KEY: "theirs",
            POLARIS_CALL_SERVER_API_SECRET: "not-ours-to-write-down"
        };

        const key = await ensureCallKey();
        expect(key?.apiKey).toBe(CALL_API_KEY);
        expect(key?.apiSecret).not.toBe("not-ours-to-write-down");
    });

    it("does not adopt a secret that is this instance's own", async () => {
        // An install that aliased the two carries one value in both lines, and
        // this file is mounted by another container: seeding it would hand that
        // container the secret every session here is signed with.
        env = {
            POLARIS_AUTH_SECRET: "one-secret-for-both",
            POLARIS_CALL_SERVER_API_SECRET: "one-secret-for-both"
        };

        expect((await ensureCallKey())?.apiSecret).not.toBe("one-secret-for-both");
    });

    it("ignores the environment once the file exists", async () => {
        const first = await ensureCallKey();
        forgetCallKey();
        env = { POLARIS_CALL_SERVER_API_SECRET: "something-else" };

        expect((await ensureCallKey())?.apiSecret).toBe(first!.apiSecret);
    });

    it("reads back what it wrote", async () => {
        const key = await ensureCallKey();
        expect(await readCallKey()).toEqual(key);
    });

    it("reads a pair a plain writer left unquoted", async () => {
        await writeFile(callKeyFile(), "polaris: plain\n", "utf8");
        expect(await readCallKey()).toEqual({ apiKey: "polaris", apiSecret: "plain" });
    });

    it("reads nothing from a file that is not a pair", async () => {
        await writeFile(callKeyFile(), "not a key file\n", "utf8");
        expect(await readCallKey()).toBeNull();
    });

    it("replaces a file that is not a pair rather than leaving calls broken", async () => {
        await writeFile(callKeyFile(), "not a key file\n", "utf8");
        // Nothing on the machine repairs this otherwise, and what it costs is a
        // deployment whose calls never work again.
        const key = await ensureCallKey();
        expect(key?.apiKey).toBe(CALL_API_KEY);
        forgetCallKey();
        expect(await readCallKey()).toEqual(key);
    });

    it("says so rather than throwing when there is no volume", async () => {
        process.env.POLARIS_CALL_KEYS_DIR = join(dir, "no-such-directory");
        // A dev run outside compose. It has no media server either, and the
        // screens say that; an exception here would take the whole page.
        expect(await ensureCallKey()).toBeNull();
    });
});
