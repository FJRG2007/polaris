/**
 * The framed prompts: asked only when a person is at the terminal, answered
 * by a flag or an argument otherwise, and a Ctrl+C that changes nothing.
 */

import { run } from "../../src/cli.js";
import { describe, expect, it } from "vitest";
import { CANCEL, fakeUi } from "../helpers/ui.js";
import { Cancelled, inCi } from "../../src/ui.js";
import { testContext } from "../helpers/context.js";
import { ID, clean, env, server } from "../helpers/deploy-server.js";

/** The requests that change something. */
const writes = <Seen extends { method: string }>(seen: Seen[]) =>
    seen.filter((each) => each.method !== "GET");

describe("when the prompts are used", () => {
    it("never with --json, --yes or CI, even at a terminal", async () => {
        for (const [argv, extra] of [
            [["service", "restart", "shop/web", "--json"], {}],
            [["env", "remove", "shop/web", "DATABASE_URL", "--yes"], {}],
            [["service", "restart", "shop/web"], { CI: "true" }]
        ] as const) {
            const { fetch, seen } = server();
            const { ui, shown } = fakeUi();
            const { context } = await testContext({ env: { ...env, ...extra }, fetch, ui });
            await run(argv, context, clean);
            expect(shown).toEqual([]);
            expect(writes(seen)).toHaveLength(1);
        }
    });

    it("reads CI the way CI providers set it", () => {
        expect(inCi({ CI: "true" })).toBe(true);
        expect(inCi({ CI: "1" })).toBe(true);
        expect(inCi({ CI: "false" })).toBe(false);
        expect(inCi({ CI: "0" })).toBe(false);
        expect(inCi({})).toBe(false);
    });
});

describe("choosing what a command acts on", () => {
    it("picks the service from the list when none is named", async () => {
        const { fetch, seen } = server();
        const { ui, shown } = fakeUi([true]);
        const { context } = await testContext({ env, fetch, ui });
        await run(["service", "deploy"], context, clean);
        expect(shown).toContain("info: Service: shop/production/web");
        expect(shown).toContain("confirm: Deploy shop/production/web again?");
        expect(shown).toContain("spinner done: Deployment d2 started");
        expect(writes(seen).map((each) => each.url)).toEqual([
            `https://polaris.example.com/api/v1/deploy/services/${ID}/deploy`
        ]);
    });

    it("without a person, a missing service is a sentence naming what to pass", async () => {
        const { fetch } = server();
        const { context } = await testContext({ env, fetch });
        await expect(run(["service", "deploy"], context, clean)).rejects.toThrow(
            /project\/service.*POLARIS_SERVICE/
        );
    });

    it("asks the Polaris to sign in to, and checks the address as it is typed", async () => {
        const { ui } = fakeUi(["not a url/with path"]);
        const { context } = await testContext({ ui });
        await expect(run(["login"], context, clean)).rejects.toThrow(/validation refused/);
    });

    it("chooses a profile to switch to", async () => {
        const { ui } = fakeUi();
        const { context, stdout } = await testContext({ ui });
        // No profiles: the same sentence as without a terminal.
        await expect(run(["profile", "use"], context, clean)).rejects.toThrow(
            /plr profile use <name>/
        );
        expect(stdout()).toBe("");
    });
});

describe("confirming before a change", () => {
    it("a restart is confirmed, and No changes nothing", async () => {
        const { fetch, seen } = server();
        const { ui, shown } = fakeUi([false]);
        const { context } = await testContext({ env, fetch, ui });
        await run(["service", "restart", "shop/web"], context, clean);
        expect(shown).toContain("outro: Nothing was restarted.");
        expect(writes(seen)).toEqual([]);
    });

    it("a removal is confirmed, and Yes removes it", async () => {
        const { fetch, seen } = server();
        const { ui, shown } = fakeUi([true]);
        const { context, stdout } = await testContext({ env, fetch, ui });
        await run(["env", "remove", "shop/web", "DATABASE_URL"], context, clean);
        expect(shown[0]).toBe("confirm: Remove DATABASE_URL from shop/production/web?");
        expect(shown.at(-1)).toMatch(/^success: Removed DATABASE_URL/);
        expect(writes(seen)).toHaveLength(1);
        expect(stdout()).toBe("");
    });

    it("a secret is typed at a masked prompt and never printed", async () => {
        const value = "s3cr3t-fixture-value";
        const { fetch, seen } = server();
        const { ui, shown } = fakeUi([value]);
        const { context, stdout, stderr } = await testContext({ env, fetch, ui });
        await run(["env", "set", "shop/web", "DATABASE_URL"], context, clean).catch(() => null);
        expect(shown[0]).toBe("password: Value for DATABASE_URL (not shown)");
        expect([...shown, stdout(), stderr()].join("\n")).not.toContain(value);
        expect(seen.some((each) => each.method === "PUT")).toBe(true);
    });
});

describe("Ctrl+C", () => {
    it("at a confirm ends the command with 130 and changes nothing", async () => {
        const { fetch, seen } = server();
        const { ui } = fakeUi([CANCEL]);
        const { context } = await testContext({ env, fetch, ui });
        const failure = await run(["service", "restart", "shop/web"], context, clean).catch(
            (caught: unknown) => caught
        );
        expect(failure).toBeInstanceOf(Cancelled);
        expect((failure as Cancelled).exitCode).toBe(130);
        expect((failure as Cancelled).quiet).toBe(true);
        expect(writes(seen)).toEqual([]);
    });

    it("at the masked prompt stores nothing", async () => {
        const { fetch, seen } = server();
        const { ui } = fakeUi([CANCEL]);
        const { context } = await testContext({ env, fetch, ui });
        await expect(
            run(["env", "set", "shop/web", "DATABASE_URL"], context, clean)
        ).rejects.toBeInstanceOf(Cancelled);
        expect(writes(seen)).toEqual([]);
    });
});
