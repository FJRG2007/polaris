/**
 * What scripts parse: every command's output when nobody is at the terminal,
 * recorded before the interactive prompts and the terminal UI were added. A
 * change here breaks somebody's pipeline, so the snapshot is the contract.
 */

import { run } from "../../src/cli.js";
import { describe, expect, it } from "vitest";
import { testContext } from "../helpers/context.js";
import { clean, env, server } from "../helpers/deploy-server.js";

const LINES: readonly (readonly string[])[] = [
    [],
    ["project", "list"],
    ["project", "list", "--json"],
    ["service", "view", "shop/web"],
    ["service", "deploy", "shop/web"],
    ["service", "deploy", "shop/web", "--json"],
    ["service", "restart", "shop/web"],
    ["service", "logs", "shop/web"],
    ["deployment", "list", "shop/web"],
    ["env", "list", "shop/web"],
    ["env", "remove", "shop/web", "DATABASE_URL", "--yes"],
    ["auth", "whoami"],
    ["auth", "whoami", "--json"]
];

describe("output with nobody at the terminal", () => {
    for (const argv of LINES) {
        it(`plr ${argv.join(" ")}`, async () => {
            const { fetch } = server();
            const { context, stdout, stderr } = await testContext({ env, fetch });
            await run(argv, context, clean);
            expect({ stdout: stdout(), stderr: stderr() }).toMatchSnapshot();
        });
    }

    it("a confirm nobody can answer names the flag", async () => {
        const { fetch } = server();
        const { context } = await testContext({ env, fetch });
        await expect(
            run(["env", "remove", "shop/web", "DATABASE_URL"], context, clean)
        ).rejects.toThrow(/--yes/);
    });
});
