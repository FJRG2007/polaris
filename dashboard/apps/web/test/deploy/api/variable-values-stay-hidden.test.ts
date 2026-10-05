/**
 * A variable's value goes in and never comes back out.
 *
 * Driven through the real REST routes, the real deploy surface and the real MCP
 * protocol, with only the store, the access checks and the audit writer stood
 * in for. Every place a value could escape is watched at once - the response
 * body, the MCP result, the audit entry, the activity feed and the server log -
 * on success and on each way a write can fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VALUE = "fixture-value-7f3a9c-not-a-real-secret";
const PLAIN_VALUE = "https://shop.fixture.example";
const APP = "33333333-3333-4333-8333-333333333333";
const OWNER = "owner-1";

const setEnvVar = vi.fn();
const deleteEnvVar = vi.fn();
const envVarIdByKey = vi.fn();
const recordDeployAudit = vi.fn();
const recordActivity = vi.fn();
const requireApplicationAccess = vi.fn();
const listEnvVarNames = vi.fn();

vi.mock("@polaris/db", () => ({ prisma: { application: { findMany: async () => [] } } }));
vi.mock("@/lib/api-key-auth", () => ({
    authenticateApiKey: async () => ({
        keyId: "key-1",
        userId: "user-1",
        scopes: ["deploy.read", "deploy.manage"],
        projectId: null
    })
}));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: true, retryAfterMs: 0 })
}));
vi.mock("@/lib/deploy-project-access", () => ({
    requireApplicationAccess: (...args: unknown[]) => requireApplicationAccess(...args),
    requireDeploymentAccess: vi.fn(),
    requireDomainAccess: vi.fn(),
    requireEnvironmentAccess: vi.fn(),
    projectAccess: vi.fn(),
    accessCan: () => true,
    accessInEnvironment: () => true,
    visibleProjectIds: async () => []
}));
vi.mock("@/lib/deploy-service", () => ({
    redeployForEnvScope: async () => undefined,
    getApplicationDeployStatuses: async () => ({})
}));
vi.mock("@/lib/deploy-audit", () => ({
    recordDeployAudit: (...args: unknown[]) => recordDeployAudit(...args),
    deployTargetOrgId: async () => null
}));
vi.mock("@/lib/activity/activity", () => ({
    record: (...args: unknown[]) => recordActivity(...args)
}));
vi.mock("@/lib/domain-dns", () => ({ provisionHostnameDns: async () => null }));
vi.mock("@/lib/env-var-service", () => ({
    setEnvVar: (...args: unknown[]) => setEnvVar(...args),
    deleteEnvVar: (...args: unknown[]) => deleteEnvVar(...args),
    envVarIdByKey: (...args: unknown[]) => envVarIdByKey(...args),
    listEnvVarNames: (...args: unknown[]) => listEnvVarNames(...args),
    envVarScope: async () => null,
    listEnvVars: async () => [],
    revealEnvVar: async () => null,
    setEnvVars: async () => 0,
    parseDotEnv: () => []
}));

const envRoute = await import("@/app/api/v1/deploy/services/[id]/env/route");
const namedRoute = await import("@/app/api/v1/deploy/services/[id]/env/[name]/route");
const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");

/** Everything the server wrote to its log during a test. */
let logged: unknown[][] = [];

beforeEach(() => {
    vi.clearAllMocks();
    logged = [];
    for (const method of ["error", "warn", "log", "info", "debug"] as const) {
        vi.spyOn(console, method).mockImplementation(
            (...args: unknown[]) => void logged.push(args)
        );
    }
    requireApplicationAccess.mockResolvedValue({
        projectId: "project-1",
        ownerId: OWNER,
        role: "owner",
        isOwner: true,
        capabilities: [],
        environmentIds: null,
        environmentId: "env-1"
    });
    setEnvVar.mockResolvedValue({ created: true });
    envVarIdByKey.mockResolvedValue("var-1");
    deleteEnvVar.mockResolvedValue({ scope: "application", scopeId: APP });
    listEnvVarNames.mockResolvedValue([
        {
            id: "var-1",
            key: "API_TOKEN",
            isSecret: true,
            updatedAt: new Date("2026-10-01T10:00:00Z")
        },
        {
            id: "var-2",
            key: "PUBLIC_URL",
            isSecret: false,
            updatedAt: new Date("2026-10-02T10:00:00Z")
        }
    ]);
});

afterEach(() => vi.restoreAllMocks());

/** Everything that could have carried a value out, as one string to search. */
function everythingSaid(...extra: unknown[]): string {
    const text = (value: unknown) =>
        value instanceof Error
            ? `${value.name} ${value.message} ${value.stack ?? ""}`
            : JSON.stringify(value);
    return [
        ...extra.map(text),
        ...logged.flat().map(text),
        ...recordDeployAudit.mock.calls.flat().map(text),
        ...recordActivity.mock.calls.flat().map(text)
    ].join("\n");
}

function put(name: string, body: unknown, query = ""): Promise<Response> {
    return namedRoute.PUT(
        new Request(
            `https://polaris.example.com/api/v1/deploy/services/${APP}/env/${name}${query}`,
            {
                method: "PUT",
                headers: {
                    authorization: "Bearer plk_fixture.token",
                    "content-type": "application/json"
                },
                body: JSON.stringify(body)
            }
        ),
        { params: Promise.resolve({ id: APP, name }) }
    );
}

function mcp(name: string, args: Record<string, unknown>) {
    return handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        MCP_TOOLS,
        {
            userId: "user-1",
            isAdmin: false,
            scopes: ["deploy.read", "deploy.manage"],
            keyId: "key-1",
            projectId: null
        },
        { name: "polaris", version: "1", instructions: "" }
    );
}

describe("the REST routes", () => {
    it("list names, secrecy and dates, and no value of either kind", async () => {
        const response = await envRoute.GET(
            new Request(`https://polaris.example.com/api/v1/deploy/services/${APP}/env`, {
                headers: { authorization: "Bearer plk_fixture.token" }
            }),
            { params: Promise.resolve({ id: APP }) }
        );
        const body = (await response.json()) as { variables: Record<string, unknown>[] };
        expect(body.variables).toEqual([
            { key: "API_TOKEN", isSecret: true, updatedAt: "2026-10-01T10:00:00.000Z" },
            { key: "PUBLIC_URL", isSecret: false, updatedAt: "2026-10-02T10:00:00.000Z" }
        ]);
    });

    it("store a value and answer without it, auditing the name only", async () => {
        const response = await put("API_TOKEN", { value: VALUE });
        const body = await response.text();
        expect(response.status).toBe(200);
        expect(JSON.parse(body)).toEqual({ saved: "API_TOKEN", created: true, redeployed: false });
        expect(setEnvVar).toHaveBeenCalledWith("application", APP, OWNER, {
            key: "API_TOKEN",
            value: VALUE,
            isSecret: true
        });
        expect(recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "deploy.variable.set",
                metadata: expect.objectContaining({ key: "API_TOKEN" })
            })
        );
        expect(everythingSaid(body)).not.toContain(VALUE);
    });

    it("keep the value out when the store fails with an error that quotes it", async () => {
        // The shape an ORM validation error takes: the arguments, value included.
        const quoting = Object.assign(
            new Error(`Invalid \`prisma.envVar.create()\` invocation: { value: "${VALUE}" }`),
            {
                code: "P2000"
            }
        );
        setEnvVar.mockRejectedValue(quoting);
        const response = await put("API_TOKEN", { value: VALUE });
        const body = await response.text();
        expect(response.status).toBe(500);
        expect(logged.length).toBeGreaterThan(0);
        expect(everythingSaid(body)).not.toContain(VALUE);
    });

    it("keep the value out when a plain service error happens to repeat it", async () => {
        setEnvVar.mockRejectedValue(new Error(`Could not store ${VALUE}`));
        const body = await (await put("API_TOKEN", { value: VALUE })).text();
        expect(everythingSaid(body)).not.toContain(VALUE);
    });

    it("pass the service layer's own sentence on when it names only the variable", async () => {
        setEnvVar.mockRejectedValue(new Error("API_TOKEN is longer than 64 KB."));
        const response = await put("API_TOKEN", { value: VALUE });
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({ error: "API_TOKEN is longer than 64 KB." });
    });

    it("refuse a value of the wrong shape without repeating it", async () => {
        const huge = `${VALUE}${"x".repeat(70_000)}`;
        const body = await (await put("API_TOKEN", { value: huge })).text();
        expect(body).not.toContain(VALUE);
        const wrongType = await (await put("API_TOKEN", { value: { nested: VALUE } })).text();
        expect(wrongType).not.toContain(VALUE);
        expect(setEnvVar).not.toHaveBeenCalled();
    });

    it("refuse a malformed name before touching the store", async () => {
        const response = await put("1BAD-NAME", { value: VALUE });
        expect(response.status).toBe(400);
        expect(setEnvVar).not.toHaveBeenCalled();
    });

    it("remove a variable by name, audited with its name", async () => {
        const response = await namedRoute.DELETE(
            new Request(`https://polaris.example.com/api/v1/deploy/services/${APP}/env/API_TOKEN`, {
                method: "DELETE",
                headers: { authorization: "Bearer plk_fixture.token" }
            }),
            { params: Promise.resolve({ id: APP, name: "API_TOKEN" }) }
        );
        expect(await response.json()).toEqual({ removed: "API_TOKEN", redeployed: false });
        expect(envVarIdByKey).toHaveBeenCalledWith("application", APP, "API_TOKEN");
        expect(deleteEnvVar).toHaveBeenCalledWith("var-1", OWNER);
        expect(recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "deploy.variable.delete",
                metadata: expect.objectContaining({ key: "API_TOKEN", variableId: "var-1" })
            })
        );
    });

    it("say plainly when there is no variable by that name", async () => {
        envVarIdByKey.mockResolvedValue(null);
        const response = await namedRoute.DELETE(
            new Request(`https://polaris.example.com/api/v1/deploy/services/${APP}/env/MISSING`, {
                method: "DELETE",
                headers: { authorization: "Bearer plk_fixture.token" }
            }),
            { params: Promise.resolve({ id: APP, name: "MISSING" }) }
        );
        expect(response.status).toBe(404);
        expect(deleteEnvVar).not.toHaveBeenCalled();
    });
});

describe("the MCP tools", () => {
    type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: unknown };

    it("env_list and deploy_variables answer names only, never a plain value", async () => {
        for (const tool of ["env_list", "deploy_variables"]) {
            const result = (await mcp(tool, { service: APP }))?.result as Result;
            expect(result.content[0]?.text).toContain("API_TOKEN (secret)");
            expect(result.content[0]?.text).toContain("PUBLIC_URL");
            expect(everythingSaid(result)).not.toContain(PLAIN_VALUE);
            const rows = (result.structuredContent as { variables: Record<string, unknown>[] })
                .variables;
            for (const row of rows)
                expect(Object.keys(row).sort()).toEqual(["isSecret", "key", "updatedAt"]);
        }
    });

    it("env_set stores the value and never repeats it", async () => {
        setEnvVar.mockResolvedValue({ created: false });
        const result = (await mcp("env_set", { service: APP, name: "API_TOKEN", value: VALUE }))
            ?.result as Result;
        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("API_TOKEN is replaced");
        expect(result.structuredContent).toEqual({
            name: "API_TOKEN",
            created: false,
            redeployed: false
        });
        expect(everythingSaid(result)).not.toContain(VALUE);
    });

    it("env_set keeps the value out of the answer and the log when the store fails", async () => {
        setEnvVar.mockRejectedValue(
            Object.assign(new Error(`Unique constraint failed on { value: "${VALUE}" }`), {
                code: "P2002"
            })
        );
        const result = (await mcp("env_set", { service: APP, name: "API_TOKEN", value: VALUE }))
            ?.result as Result;
        expect(result.isError).toBe(true);
        expect(logged.length).toBeGreaterThan(0);
        expect(everythingSaid(result)).not.toContain(VALUE);
    });

    it("env_set refuses arguments of the wrong shape without repeating the value", async () => {
        const answer = await mcp("env_set", {
            service: APP,
            name: "API_TOKEN",
            value: `${VALUE}${"x".repeat(70_000)}`
        });
        expect(answer?.error?.code).toBe(-32602);
        expect(everythingSaid(answer)).not.toContain(VALUE);
        expect(setEnvVar).not.toHaveBeenCalled();
    });

    it("env_delete removes by name", async () => {
        const result = (await mcp("env_delete", { service: APP, name: "API_TOKEN" }))
            ?.result as Result;
        expect(result.structuredContent).toEqual({
            name: "API_TOKEN",
            removed: true,
            redeployed: false
        });
        expect(deleteEnvVar).toHaveBeenCalledWith("var-1", OWNER);
    });

    it("ask for deploy.read to list and deploy.manage to change", () => {
        const scope = (name: string) => MCP_TOOLS.find((tool) => tool.name === name)?.scope;
        expect(scope("env_list")).toBe("deploy.read");
        expect(scope("env_set")).toBe("deploy.manage");
        expect(scope("env_delete")).toBe("deploy.manage");
    });
});
