/**
 * The CLI comes from GitHub and Polaris from its own Update button, so the two
 * can drift. Every call compares the CLI's protocol with the range the server
 * names, and a mismatch stops the command with the exact thing to run.
 */

import { z } from "zod";
import { call } from "../../src/api.js";
import { describe, expect, it } from "vitest";
import { CliError } from "../../src/errors.js";
import { CLI_PROTOCOL, PROTOCOL_HEADER, compatibilityProblem } from "../../src/compat.js";

const URL = "https://polaris.example.com";

describe("the protocol check", () => {
    it("passes a server whose range holds this CLI, and one that names none", () => {
        expect(compatibilityProblem(URL, `${CLI_PROTOCOL}-${CLI_PROTOCOL}`)).toBeNull();
        expect(compatibilityProblem(URL, "1-9", 4)).toBeNull();
        // A Polaris from before the header speaks protocol 1.
        expect(compatibilityProblem(URL, null)).toBeNull();
        // Junk is not a range, and is not read as one.
        expect(compatibilityProblem(URL, "latest")).toBeNull();
    });

    it("says to run plr update when the CLI is too old", () => {
        expect(compatibilityProblem(URL, "2-3", 1)).toBe(
            `This CLI is too old for Polaris at ${URL}. Update it with plr update, then try again.`
        );
    });

    it("says to update Polaris, or take its CLI, when the CLI is too new", () => {
        expect(compatibilityProblem(URL, "1-1", 2)).toBe(
            `Polaris at ${URL} is older than this CLI. Update Polaris from Settings > Update, or install the CLI it serves with plr update --url ${URL}.`
        );
    });
});

describe("every call", () => {
    const connection = { url: URL, token: "plk_TESTONLY.fixture" };
    const answering =
        (header: string | null, status = 200): typeof fetch =>
        async () =>
            Response.json(
                { ok: true },
                { status, headers: header ? { [PROTOCOL_HEADER]: header } : {} }
            );

    it("stops on a mismatch before reading the answer, whatever its status", async () => {
        for (const status of [200, 401, 404, 500]) {
            const failed = await call(connection, "GET", "/api/v1/me", z.object({}), {
                fetch: answering(`${CLI_PROTOCOL + 1}-${CLI_PROTOCOL + 2}`, status)
            }).catch((caught: unknown) => caught);
            expect(failed).toBeInstanceOf(CliError);
            expect((failed as CliError).message).toContain("plr update");
        }
    });

    it("goes through when the versions match or the server does not say", async () => {
        const schema = z.object({ ok: z.boolean() });
        for (const header of [`${CLI_PROTOCOL}-${CLI_PROTOCOL}`, null]) {
            expect(
                await call(connection, "GET", "/api/v1/me", schema, { fetch: answering(header) })
            ).toEqual({ ok: true });
        }
    });
});
