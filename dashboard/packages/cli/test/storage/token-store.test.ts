/**
 * Where a token is kept: the keychain first, a 0600 file when there is none -
 * and never on a command line, where every account on the machine could read it.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Host } from "../../src/paths.js";
import { fakeKeychain, tempDir } from "../helpers/context.js";
import { readFile, stat } from "node:fs/promises";
import { keychainStore, secrets, type Runner } from "../../src/secrets.js";

const TOKEN = "plk_TESTONLY.fixture-secret-value-0123456789";

async function setup(platform: NodeJS.Platform = "linux", env: Record<string, string> = {}) {
    const dir = await tempDir("plr-secrets-");
    const host: Host = { platform, env, home: dir };
    return { dir, host };
}

describe("with a keychain", () => {
    it("keeps the token there, hands it over on stdin, and reads it back", async () => {
        const { dir, host } = await setup();
        const keychain = fakeKeychain();
        const store = secrets(host, dir, keychain.run);

        expect(await store.save("work", TOKEN)).toBe("keychain");
        expect(keychain.entries.get("work")).toBe(TOKEN);
        expect(await store.read("work", "keychain")).toBe(TOKEN);
        // The secret is never an argument of any program the store started.
        for (const call of keychain.calls) expect(call.args.join(" ")).not.toContain(TOKEN);
        // And nothing was written to the fallback file.
        await expect(readFile(join(dir, "credentials.json"), "utf8")).rejects.toThrow();
    });

    it("forgets it from the keychain and the file alike", async () => {
        const { dir, host } = await setup();
        const keychain = fakeKeychain();
        const store = secrets(host, dir, keychain.run);
        await store.save("work", TOKEN);
        await store.forget("work");
        expect(keychain.entries.has("work")).toBe(false);
        expect(await store.read("work", "keychain")).toBeNull();
    });
});

describe("without a keychain", () => {
    const absent: Runner = async () => ({ code: null, stdout: "", started: false });

    it("falls back to credentials.json, readable only by its owner", async () => {
        const { dir, host } = await setup();
        const store = secrets(host, dir, absent);
        expect(await store.save("work", TOKEN)).toBe("file");
        expect(await store.read("work", "file")).toBe(TOKEN);
        if (process.platform !== "win32") {
            const mode = (await stat(join(dir, "credentials.json"))).mode & 0o777;
            expect(mode).toBe(0o600);
        }
    });

    it("falls back when the keychain refuses, as a locked or session-less one does", async () => {
        const { dir, host } = await setup();
        const refuses: Runner = async () => ({ code: 1, stdout: "", started: true });
        expect(await secrets(host, dir, refuses).save("work", TOKEN)).toBe("file");
    });

    it("skips the keychain when POLARIS_CLI_NO_KEYCHAIN=1", async () => {
        const { dir, host } = await setup("linux", { POLARIS_CLI_NO_KEYCHAIN: "1" });
        const keychain = fakeKeychain();
        expect(await secrets(host, dir, keychain.run).save("work", TOKEN)).toBe("file");
        expect(keychain.calls).toEqual([]);
    });

    it("keeps each profile's token apart and removes only the one asked", async () => {
        const { dir, host } = await setup();
        const store = secrets(host, dir, absent);
        await store.save("a", TOKEN);
        await store.save("b", `${TOKEN}b`);
        await store.forget("a");
        expect(await store.read("a", "file")).toBeNull();
        expect(await store.read("b", "file")).toBe(`${TOKEN}b`);
    });
});

it("refuses something that is not a Polaris token before storing it anywhere", async () => {
    const { dir, host } = await setup();
    const keychain = fakeKeychain();
    const store = secrets(host, dir, keychain.run);
    await expect(store.save("work", "plk_x y; rm -rf /")).rejects.toThrow(/does not recognise/);
    expect(keychain.calls).toEqual([]);
});

describe("each system's own tool", () => {
    it("drives Windows' Credential Locker with a fixed script, the profile in the environment and the token on stdin", async () => {
        const calls: {
            command: string;
            args: readonly string[];
            input?: string;
            env?: Record<string, string>;
        }[] = [];
        const run: Runner = async (command, args, options = {}) => {
            calls.push({ command, args, input: options.input, env: options.env });
            return { code: 0, stdout: "", started: true };
        };
        const { host } = await setup("win32");
        await keychainStore(host, run).set("work", TOKEN);
        const [call] = calls;
        expect(call?.command).toBe("powershell.exe");
        expect(call?.args).toContain("-EncodedCommand");
        expect(call?.args.join(" ")).not.toContain(TOKEN);
        expect(call?.input).toBe(TOKEN);
        expect(call?.env).toMatchObject({
            POLARIS_CLI_OP: "set",
            POLARIS_CLI_ACCOUNT: "work",
            POLARIS_CLI_SERVICE: "polaris-cli"
        });
    });

    it("writes to the macOS Keychain through security's stdin, never its arguments", async () => {
        const calls: { args: readonly string[]; input?: string }[] = [];
        const run: Runner = async (_command, args, options = {}) => {
            calls.push({ args, input: options.input });
            // find-generic-password answers with what was stored.
            return {
                code: 0,
                stdout: args[0] === "find-generic-password" ? `${TOKEN}\n` : "",
                started: true
            };
        };
        const { host } = await setup("darwin");
        expect(await keychainStore(host, run).set("work", TOKEN)).toBe(true);
        expect(calls[0]?.args).toEqual(["-i"]);
        expect(calls[0]?.input).toContain(TOKEN);
        for (const call of calls) expect(call.args.join(" ")).not.toContain(TOKEN);
    });
});
