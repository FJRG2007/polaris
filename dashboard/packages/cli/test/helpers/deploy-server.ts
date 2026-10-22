/**
 * A Polaris with one project, one environment and one service, signed in with
 * an API key: what the command tests run against.
 */

import { scriptedFetch } from "./context.js";
import type { Probe } from "../../src/guard.js";

export const URL = "https://polaris.example.com";
export const TOKEN = "plk_TESTONLY.fixture-secret-value-0123456789";
export const clean: Probe = { exists: () => false, read: () => null };
export const env = { POLARIS_TOKEN: TOKEN, POLARIS_URL: URL };
export const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

export const SERVICE = {
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

export function server() {
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
