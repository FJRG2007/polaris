/**
 * Signing in once and having every later command use it: the whole of `plr
 * login`, `whoami`, `logout` and profile switching, against a scripted server.
 */

import { run } from "../../src/cli.js";
import { describe, expect, it } from "vitest";
import { CliError } from "../../src/errors.js";
import type { Probe } from "../../src/guard.js";
import { loadConfig } from "../../src/config.js";
import { fakeKeychain, scriptedFetch, testContext } from "../helpers/context.js";

const URL = "https://polaris.example.com";
const TOKEN = "plk_TESTONLY.fixture-secret-value-0123456789";
const clean: Probe = { exists: () => false, read: () => null };

const AUTHORIZED = {
    userCode: "BCDFGHJK",
    deviceCode: "device-code-fixture-0123456789",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    pollMs: 2000,
    verificationPath: "/account/cli",
    approvePath: "/account/cli?code=BCDFGHJK"
};

const APPROVED = {
    status: "approved",
    token: TOKEN,
    keyId: "key-1",
    scopes: ["deploy.read", "deploy.manage"],
    account: { id: "u-1", name: "Ada", email: "ada@example.com" }
};

/** A server that answers `pending` `waits` times and then `final`. */
function server(final: object, waits = 1) {
    let polls = 0;
    return scriptedFetch({
        "POST /api/cli/authorize": () => Response.json(AUTHORIZED),
        "POST /api/cli/authorize/claim": () =>
            Response.json(polls++ < waits ? { status: "pending" } : final),
        "GET /api/v1/me": ({ headers }) =>
            headers.get("authorization") === `Bearer ${TOKEN}`
                ? Response.json({
                      user: { id: "u-1", name: "Ada", email: "ada@example.com", username: "ada" },
                      key: { id: "key-1", scopes: APPROVED.scopes }
                  })
                : Response.json({ error: "Unauthorized" }, { status: 401 }),
        "DELETE /api/cli/session": () => new Response(null, { status: 204 })
    });
}

async function failure(promise: Promise<unknown>): Promise<CliError> {
    try {
        await promise;
    } catch (caught) {
        expect(caught).toBeInstanceOf(CliError);
        return caught as CliError;
    }
    throw new Error("expected a failure");
}

describe("plr login", () => {
    it("opens the approval page, waits, and keeps the token in the keychain", async () => {
        const keychain = fakeKeychain();
        const { fetch, seen } = server(APPROVED, 2);
        const { context, stdout, opened, dir } = await testContext({ fetch, run: keychain.run });

        await run(["login", "--url", URL], context, clean);

        expect(opened).toEqual([`${URL}/account/cli?code=BCDFGHJK`]);
        expect(stdout()).toContain("BCDF-GHJK");
        expect(stdout()).toContain(
            "Signed in to https://polaris.example.com as Ada <ada@example.com>"
        );
        expect(keychain.entries.get("polaris.example.com")).toBe(TOKEN);

        // What it asked for, and who it said it was.
        const asked = seen.find((request) => request.url.endsWith("/api/cli/authorize"));
        expect(asked?.body).toMatchObject({
            deviceName: "test-laptop",
            scopes: ["deploy.read", "deploy.manage"]
        });
        expect(asked?.headers.get("authorization")).toBeNull();

        // The profile holds no secret.
        const config = await loadConfig(`${dir}/config`);
        expect(config.current).toBe("polaris.example.com");
        expect(JSON.stringify(config)).not.toContain(TOKEN);
        expect(config.profiles["polaris.example.com"]).toMatchObject({
            url: URL,
            keyId: "key-1",
            storage: "keychain"
        });
    });

    it("shows the address and the code instead when there is no browser here", async () => {
        const { fetch } = server(APPROVED);
        const { context, stdout, opened } = await testContext({ fetch, browser: false });
        await run(["login", "--url", URL], context, clean);
        expect(opened).toEqual([]);
        expect(stdout()).toContain(`open ${URL}/account/cli`);
        expect(stdout()).toContain("type the code BCDF-GHJK");
    });

    it("does not try the browser with --browserless", async () => {
        const { fetch } = server(APPROVED);
        const { context, opened } = await testContext({ fetch });
        await run(["login", "--url", URL, "--browserless"], context, clean);
        expect(opened).toEqual([]);
    });

    it("stops and saves nothing when the request is turned away", async () => {
        const { fetch } = server({ status: "denied" });
        const { context, dir } = await testContext({ fetch });
        const error = await failure(run(["login", "--url", URL], context, clean));
        expect(error.message).toContain("turned away");
        expect((await loadConfig(`${dir}/config`)).profiles).toEqual({});
    });

    it("says to start again when the code expires", async () => {
        const { fetch } = server({ status: "expired" });
        const { context } = await testContext({ fetch });
        expect((await failure(run(["login", "--url", URL], context, clean))).message).toContain(
            "expired"
        );
    });

    it("rides out a dropped poll while somebody is approving", async () => {
        let polls = 0;
        const { fetch } = scriptedFetch({
            "POST /api/cli/authorize": () => Response.json(AUTHORIZED),
            "POST /api/cli/authorize/claim": () => {
                polls += 1;
                if (polls === 1)
                    throw Object.assign(new TypeError("fetch failed"), {
                        cause: { code: "ECONNRESET" }
                    });
                return Response.json(APPROVED);
            }
        });
        const { context, stdout } = await testContext({ fetch });
        await run(["login", "--url", URL], context, clean);
        expect(stdout()).toContain("Signed in");
    });

    it("asks for the address when none is known, and refuses when nobody can answer", async () => {
        const { context } = await testContext();
        expect((await failure(run(["login"], context, clean))).message).toContain(
            "plr login --url"
        );
    });
});

describe("after signing in", () => {
    it("every command uses the stored sign-in, with no credential typed", async () => {
        const { fetch } = server(APPROVED);
        const { context, stdout } = await testContext({ fetch });
        await run(["login", "--url", URL], context, clean);
        await run(["whoami", "--json"], context, clean);
        const printed = JSON.parse(stdout().slice(stdout().indexOf("{")));
        expect(printed).toMatchObject({
            url: URL,
            profile: "polaris.example.com",
            user: { email: "ada@example.com" }
        });
    });

    it("keeps one profile per Polaris and switches between them", async () => {
        const { fetch } = server(APPROVED, 0);
        const { context, dir } = await testContext({ fetch });
        await run(["login", "--url", URL], context, clean);
        await run(
            ["login", "--url", "https://other.example.com", "--profile", "other"],
            context,
            clean
        );
        expect((await loadConfig(`${dir}/config`)).current).toBe("other");
        await run(["profile", "use", "polaris.example.com"], context, clean);
        expect((await loadConfig(`${dir}/config`)).current).toBe("polaris.example.com");
        await expect(run(["profile", "use", "missing"], context, clean)).rejects.toThrow(
            /no profile named/
        );
    });

    it("logout revokes the key on the server and forgets it here", async () => {
        const keychain = fakeKeychain();
        const { fetch, seen } = server(APPROVED);
        const { context, stdout, dir } = await testContext({ fetch, run: keychain.run });
        await run(["login", "--url", URL], context, clean);
        await run(["logout"], context, clean);

        const revoked = seen.find((request) => request.method === "DELETE");
        expect(revoked?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
        expect(keychain.entries.size).toBe(0);
        expect((await loadConfig(`${dir}/config`)).profiles).toEqual({});
        expect(stdout()).toContain("Signed out of https://polaris.example.com");
    });

    it("logout still forgets the token when the server cannot be reached, and says the key still works", async () => {
        const { fetch } = server(APPROVED);
        const { context, stdout } = await testContext({ fetch });
        await run(["login", "--url", URL], context, clean);
        (context as { fetch: typeof fetch }).fetch = async () => {
            throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
        };
        await run(["logout"], context, clean);
        expect(stdout()).toContain("could not be reached to revoke");
    });

    it("a profile whose token went missing can still be removed", async () => {
        const keychain = fakeKeychain();
        const { fetch, seen } = server(APPROVED);
        const { context, stdout, dir } = await testContext({ fetch, run: keychain.run });
        await run(["login", "--url", URL], context, clean);
        keychain.entries.clear();
        await run(["profile", "remove", "polaris.example.com"], context, clean);
        expect(seen.some((request) => request.method === "DELETE")).toBe(false);
        expect((await loadConfig(`${dir}/config`)).profiles).toEqual({});
        expect(stdout()).toContain("no longer here to revoke");
    });
});

describe("POLARIS_TOKEN", () => {
    it("is used instead of any profile, for CI", async () => {
        const { fetch } = server(APPROVED);
        const { context, stdout } = await testContext({
            fetch,
            env: { POLARIS_TOKEN: TOKEN, POLARIS_URL: URL }
        });
        await run(["whoami"], context, clean);
        expect(stdout()).toContain("Ada <ada@example.com>");
    });

    it("needs POLARIS_URL to say which Polaris", async () => {
        const { context } = await testContext({ env: { POLARIS_TOKEN: TOKEN } });
        expect((await failure(run(["whoami"], context, clean))).message).toContain("POLARIS_URL");
    });
});

describe("on a machine that runs a Polaris server", () => {
    const server_: Probe = {
        exists: (path) => path === "/usr/local/bin/polaris",
        read: () => "# polaris - manage a Polaris dashboard deployment\n"
    };

    it("refuses before reading or writing any sign-in", async () => {
        const { fetch, seen } = server(APPROVED);
        const { context } = await testContext({ fetch });
        const error = await failure(run(["login", "--url", URL], context, server_));
        expect(error.message).toContain("runs a Polaris server");
        expect(seen).toEqual([]);
    });

    it("still answers --help and --version", async () => {
        const { context, stdout } = await testContext();
        await run(["--help"], context, server_);
        await run(["--version"], context, server_);
        expect(stdout()).toContain("plr login");
    });
});
