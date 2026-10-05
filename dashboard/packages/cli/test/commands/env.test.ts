/**
 * `plr env`: names in, names out. The value is read from a hidden prompt, a
 * pipe or a file, travels in the request body, and is never printed - not on
 * success, not in a refusal, not under --json.
 */

import { join } from "node:path";
import { run } from "../../src/cli.js";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Probe } from "../../src/guard.js";
import { typeKeys, withoutFinalNewline } from "../../src/secret-input.js";
import { scriptedFetch, tempDir, testContext } from "../helpers/context.js";

const URL = "https://polaris.example.com";
const TOKEN = "plk_TESTONLY.fixture-secret-value-0123456789";
const VALUE = "fixture-value-7f3a9c-not-a-real-secret";
const clean: Probe = { exists: () => false, read: () => null };
const env = { POLARIS_TOKEN: TOKEN, POLARIS_URL: URL };
const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const SERVICE = {
    id: ID,
    name: "Web",
    slug: "web",
    project: { id: "p1", name: "Shop", slug: "shop" },
    environment: { id: "e1", name: "Production", slug: "production" },
    status: "running",
    currentDeploymentId: "d1",
    source: { kind: "git", image: null, repository: "acme/shop", branch: "main", port: 3000 },
    autoDeploy: true,
    domains: []
};

function envServer(options: { created?: boolean; refuse?: string } = {}) {
    return scriptedFetch({
        "GET /api/v1/deploy/services": () => Response.json({ service: SERVICE }),
        [`GET /api/v1/deploy/services/${ID}/env`]: () =>
            Response.json({
                variables: [
                    // A field the CLI does not expect is dropped, not printed: a
                    // server that one day sent a value would still not be shown.
                    {
                        key: "API_TOKEN",
                        isSecret: true,
                        updatedAt: "2026-10-01T10:00:00.000Z",
                        value: VALUE
                    },
                    { key: "PUBLIC_URL", isSecret: false, updatedAt: "2026-10-02T10:00:00.000Z" }
                ]
            }),
        [`PUT /api/v1/deploy/services/${ID}/env/API_TOKEN`]: ({ body }) =>
            options.refuse
                ? Response.json({ error: options.refuse }, { status: 422 })
                : Response.json({
                      saved: "API_TOKEN",
                      created: options.created ?? true,
                      redeployed: (body as { redeploy?: boolean }).redeploy === true
                  }),
        [`DELETE /api/v1/deploy/services/${ID}/env/API_TOKEN`]: ({ url }) =>
            Response.json({ removed: "API_TOKEN", redeployed: url.endsWith("?redeploy=1") })
    });
}

describe("plr env ls", () => {
    it("prints names, secrecy and dates, and nothing else", async () => {
        const { fetch } = envServer();
        const { context, stdout } = await testContext({ fetch, env });
        await run(["env", "ls", "shop/web"], context, clean);
        expect(stdout()).toMatch(/NAME\s+SECRET\s+UPDATED/);
        expect(stdout()).toContain("API_TOKEN   yes     2026-10-01T10:00:00.000Z");
        expect(stdout()).not.toContain(VALUE);
    });

    it("keeps --json to the same fields", async () => {
        const { fetch } = envServer();
        const { context, stdout } = await testContext({ fetch, env });
        await run(["env", "ls", "shop/web", "--json"], context, clean);
        const rows = JSON.parse(stdout()) as Record<string, unknown>[];
        for (const row of rows)
            expect(Object.keys(row).sort()).toEqual(["isSecret", "key", "updatedAt"]);
        expect(stdout()).not.toContain(VALUE);
    });
});

describe("plr env set", () => {
    it("sends the hidden value in the body and never prints it", async () => {
        const { fetch, seen } = envServer();
        const { context, stdout, stderr } = await testContext({ fetch, env, secret: VALUE });
        await run(["env", "set", "shop/web", "API_TOKEN"], context, clean);
        const put = seen.find((request) => request.method === "PUT");
        expect(put?.url).toBe(`${URL}/api/v1/deploy/services/${ID}/env/API_TOKEN`);
        expect(put?.body).toEqual({ value: VALUE, secret: true, redeploy: false });
        expect(stdout()).toContain("Created API_TOKEN on shop/production/web.");
        expect(`${stdout()}${stderr()}`).not.toContain(VALUE);
        // The value is never in a URL, where proxies and logs keep it.
        for (const request of seen) expect(request.url).not.toContain(VALUE);
    });

    it("drops the line break a pipe or an editor adds, and says Replaced for an existing one", async () => {
        const { fetch, seen } = envServer({ created: false });
        const { context, stdout } = await testContext({ fetch, env, secret: `${VALUE}\n` });
        await run(["env", "set", "shop/web", "API_TOKEN", "--restart", "--plain"], context, clean);
        expect(seen.find((request) => request.method === "PUT")?.body).toEqual({
            value: VALUE,
            secret: false,
            redeploy: true
        });
        expect(stdout()).toContain(
            "Replaced API_TOKEN on shop/production/web. The service redeploys"
        );
    });

    it("reads --from-file", async () => {
        const dir = await tempDir();
        const file = join(dir, "value.txt");
        await writeFile(file, `${VALUE}\r\n`);
        const { fetch, seen } = envServer();
        const { context, stdout } = await testContext({ fetch, env });
        await run(
            ["env", "set", "shop/web", "API_TOKEN", "--from-file", file, "--json"],
            context,
            clean
        );
        expect(
            (seen.find((request) => request.method === "PUT")?.body as { value: string }).value
        ).toBe(VALUE);
        expect(JSON.parse(stdout())).toEqual({
            name: "API_TOKEN",
            service: ID,
            created: true,
            redeployed: false
        });
    });

    it("refuses a value on the command line without repeating it, and sends nothing", async () => {
        const { fetch, seen } = envServer();
        const { context } = await testContext({ fetch, env });
        const failure = await run(
            ["env", "set", "shop/web", "API_TOKEN", VALUE],
            context,
            clean
        ).catch((caught: Error) => caught);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/no value on the command line/);
        expect((failure as Error).message).not.toContain(VALUE);
        expect(seen).toHaveLength(0);
    });

    it("refuses an empty or abandoned value, and one a container cannot hold, naming only the variable", async () => {
        for (const secret of [null, "", "\n", `${VALUE}\twith-a-tab`, `${VALUE}\nline-2\n`]) {
            const { fetch, seen } = envServer();
            const { context } = await testContext({ fetch, env, secret });
            const failure = (await run(
                ["env", "set", "shop/web", "API_TOKEN"],
                context,
                clean
            ).catch((caught: Error) => caught)) as Error;
            expect(failure.message).toContain("API_TOKEN");
            expect(failure.message).not.toContain(VALUE);
            expect(seen.some((request) => request.method === "PUT")).toBe(false);
        }
    });

    it("refuses a malformed name before asking for a value", async () => {
        const { context } = await testContext({ env, secret: VALUE });
        await expect(run(["env", "set", "shop/web", "1BAD"], context, clean)).rejects.toThrow(
            /not a variable name/
        );
    });

    it("passes the server's refusal on", async () => {
        const { fetch } = envServer({ refuse: "API_TOKEN is longer than 64 KB." });
        const { context } = await testContext({ fetch, env, secret: VALUE });
        await expect(run(["env", "set", "shop/web", "API_TOKEN"], context, clean)).rejects.toThrow(
            "API_TOKEN is longer than 64 KB."
        );
    });
});

describe("plr env rm", () => {
    it("asks first and removes on yes, redeploying with --restart", async () => {
        const { fetch, seen } = envServer();
        const { context, stdout } = await testContext({ fetch, env, answers: ["y"] });
        await run(["env", "rm", "shop/web", "API_TOKEN", "--restart"], context, clean);
        expect(seen.at(-1)?.url).toBe(
            `${URL}/api/v1/deploy/services/${ID}/env/API_TOKEN?redeploy=1`
        );
        expect(stdout()).toContain(
            "Removed API_TOKEN from shop/production/web. The service redeploys without it."
        );
    });

    it("removes nothing on no", async () => {
        const { fetch, seen } = envServer();
        const { context, stdout } = await testContext({ fetch, env, answers: ["n"] });
        await run(["env", "rm", "shop/web", "API_TOKEN"], context, clean);
        expect(seen.some((request) => request.method === "DELETE")).toBe(false);
        expect(stdout()).toContain("Nothing was removed.");
    });

    it("needs --yes when nobody can be asked", async () => {
        const { fetch, seen } = envServer();
        const { context } = await testContext({ fetch, env });
        await expect(run(["env", "rm", "shop/web", "API_TOKEN"], context, clean)).rejects.toThrow(
            /--yes/
        );
        expect(seen.some((request) => request.method === "DELETE")).toBe(false);
        const yes = await testContext({ fetch, env });
        await run(["env", "rm", "shop/web", "API_TOKEN", "--yes"], yes.context, clean);
        expect(seen.at(-1)?.method).toBe("DELETE");
    });
});

describe("the hidden prompt", () => {
    it("finishes on Enter, erases on Backspace and gives up on Ctrl+C", () => {
        expect(typeKeys("", "abc")).toEqual({ typed: "abc", done: false, interrupted: false });
        expect(typeKeys("abc", "\u007fd\r")).toEqual({
            typed: "abd",
            done: true,
            interrupted: false
        });
        expect(typeKeys("abc", "\u0003")).toEqual({ typed: "", done: true, interrupted: true });
        expect(typeKeys("", "\u001b[Ax\u001b[200~y")).toEqual({
            typed: "xy",
            done: false,
            interrupted: false
        });
    });

    it("keeps a pasted value of several lines whole instead of its first line", () => {
        const pasted = "-----BEGIN KEY-----\nabc\n-----END KEY-----\n";
        expect(typeKeys("", pasted)).toEqual({ typed: pasted, done: true, interrupted: false });
        expect(typeKeys("abc", "\r\n")).toEqual({ typed: "abc", done: true, interrupted: false });
    });

    it("drops one final line break and keeps the rest", () => {
        expect(withoutFinalNewline("a\n")).toBe("a");
        expect(withoutFinalNewline("a\r\n")).toBe("a");
        expect(withoutFinalNewline("a\n\n")).toBe("a\n");
    });
});
