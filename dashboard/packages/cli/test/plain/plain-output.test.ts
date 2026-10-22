/**
 * What scripts parse: every command's output when nobody is at the terminal,
 * recorded before the interactive prompts and the terminal UI were added. A
 * change here breaks somebody's pipeline, so the snapshot is the contract.
 */

import { run } from "../../src/cli.js";
import { describe, expect, it } from "vitest";
import type { Probe } from "../../src/guard.js";
import { scriptedFetch, testContext } from "../helpers/context.js";

const URL = "https://polaris.example.com";
const TOKEN = "plk_TESTONLY.fixture-secret-value-0123456789";
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
    domains: [
        {
            id: "dm1",
            hostname: "shop.example.com",
            enabled: true,
            certificate: "le",
            targetPort: 3000,
            kind: "custom",
            health: "up"
        }
    ]
};

function server() {
    return scriptedFetch({
        "GET /api/v1/me": () =>
            Response.json({
                user: { id: "u1", name: "Ada", email: "ada@example.com" },
                key: { id: "k1", scopes: ["deploy.read", "deploy.manage"] }
            }),
        "GET /api/v1/deploy/projects": () =>
            Response.json({
                projects: [
                    {
                        id: "p1",
                        name: "Shop",
                        slug: "shop",
                        role: "owner",
                        environments: [
                            {
                                id: "e1",
                                name: "Production",
                                slug: "production",
                                isDefault: true,
                                services: [{ id: ID, name: "Web", slug: "web", status: "running" }]
                            }
                        ]
                    }
                ]
            }),
        "GET /api/v1/deploy/services": () => Response.json({ service: SERVICE }),
        [`GET /api/v1/deploy/services/${ID}/deployments`]: () =>
            Response.json({
                deployments: [
                    {
                        id: "d1",
                        status: "ready",
                        error: null,
                        createdAt: "2026-10-04T10:00:00.000Z",
                        isCurrent: true,
                        commitMessage: "Ship it",
                        commitSha: "abcdef0123456",
                        rollbackable: false
                    }
                ]
            }),
        [`POST /api/v1/deploy/services/${ID}/deploy`]: () =>
            Response.json({ deploymentId: "d2" }, { status: 202 }),
        [`POST /api/v1/deploy/services/${ID}/restart`]: () => Response.json({ restarted: true }),
        [`GET /api/v1/deploy/services/${ID}/logs`]: () =>
            Response.json({ log: "2026-10-04T10:00:00Z ready\n" }),
        [`GET /api/v1/deploy/services/${ID}/env`]: () =>
            Response.json({
                variables: [
                    { key: "DATABASE_URL", isSecret: true, updatedAt: "2026-10-04T10:00:00.000Z" }
                ]
            }),
        [`DELETE /api/v1/deploy/services/${ID}/env/DATABASE_URL`]: () =>
            Response.json({ removed: "DATABASE_URL", redeployed: false })
    });
}

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
