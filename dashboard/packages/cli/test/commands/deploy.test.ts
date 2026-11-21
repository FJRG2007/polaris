/**
 * The Deploy commands: a name resolved once by the server, then the id; `--json`
 * on every read; and the build followed to its end.
 */

import { run } from "../../src/cli.js";
import { describe, expect, it } from "vitest";
import type { Probe } from "../../src/guard.js";
import { scriptedFetch, testContext } from "../helpers/context.js";

const URL = "https://polaris.example.com";
const TOKEN = "plk_TESTONLY.fixture-secret-value-0123456789";
const clean: Probe = { exists: () => false, read: () => null };
const env = { POLARIS_TOKEN: TOKEN, POLARIS_URL: URL };

const SERVICE = {
    id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
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

function deployServer() {
    return scriptedFetch({
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
                                services: [
                                    { id: SERVICE.id, name: "Web", slug: "web", status: "running" }
                                ]
                            }
                        ]
                    }
                ]
            }),
        "GET /api/v1/deploy/services": () => Response.json({ service: SERVICE }),
        [`POST /api/v1/deploy/services/${SERVICE.id}/deploy`]: () =>
            Response.json({ deploymentId: "d2" }, { status: 202 }),
        [`POST /api/v1/deploy/services/${SERVICE.id}/restart`]: () =>
            Response.json({ restarted: true }),
        [`GET /api/v1/deploy/services/${SERVICE.id}/logs`]: () =>
            Response.json({ log: "2026-10-04T10:00:00Z ready\n" }),
        "GET /api/v1/deploy/deployments/d2": () => new Response("step 1\nstep 2\ndone\n")
    });
}

describe("reading", () => {
    it("lists every reachable service as project/environment/service", async () => {
        const { fetch } = deployServer();
        const { context, stdout } = await testContext({ fetch, env });
        await run(["projects"], context, clean);
        expect(stdout()).toMatch(/SERVICE\s+STATUS\s+ID/);
        expect(stdout()).toContain(`shop/production/web  running  ${SERVICE.id}`);
    });

    it("prints JSON with --json", async () => {
        const { fetch } = deployServer();
        const { context, stdout } = await testContext({ fetch, env });
        await run(["service", "shop/web", "--json"], context, clean);
        expect(JSON.parse(stdout())).toMatchObject({ id: SERVICE.id, project: { slug: "shop" } });
    });

    it("resolves a name through the server, encoded, and then uses the id", async () => {
        const { fetch, seen } = deployServer();
        const { context, stdout } = await testContext({ fetch, env });
        await run(["logs", "shop/web", "--tail", "20"], context, clean);
        expect(seen[0]?.url).toBe(`${URL}/api/v1/deploy/services?ref=shop%2Fweb`);
        expect(seen[1]?.url).toBe(`${URL}/api/v1/deploy/services/${SERVICE.id}/logs?tail=20`);
        expect(stdout()).toContain("ready");
    });

    it("asks for a service when none is named", async () => {
        const { context } = await testContext({ env });
        await expect(run(["logs"], context, clean)).rejects.toThrow(/Name a service/);
    });
});

describe("changing", () => {
    it("deploys again and follows the build to its end", async () => {
        const { fetch, seen } = deployServer();
        const { context, stdout } = await testContext({ fetch, env });
        await run(["deploy", "shop/web", "--follow"], context, clean);
        expect(stdout()).toContain("Deploying shop/production/web: deployment d2.");
        expect(stdout()).toContain("step 2\ndone");
        expect(seen.at(-1)?.url).toBe(`${URL}/api/v1/deploy/deployments/d2?follow=1`);
    });

    it("stops following a build when the server speaks a newer API", async () => {
        const { fetch } = scriptedFetch({
            "GET /api/v1/deploy/deployments/d2": () =>
                new Response("step 1\n", { headers: { "x-polaris-cli-protocol": "2-3" } })
        });
        const { context, stdout } = await testContext({ fetch, env });
        await expect(run(["build-log", "d2", "--follow"], context, clean)).rejects.toThrow(
            /too old.*plr update/
        );
        expect(stdout()).not.toContain("step 1");
    });

    it("restarts", async () => {
        const { fetch } = deployServer();
        const { context, stdout } = await testContext({ fetch, env });
        await run(["restart", "shop/web"], context, clean);
        expect(stdout()).toContain("Restarted shop/production/web.");
    });
});
