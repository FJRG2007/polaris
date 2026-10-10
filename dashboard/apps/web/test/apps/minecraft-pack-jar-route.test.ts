/**
 * Symbiote's jar through a server's pack link.
 *
 * What is pinned: the jar is answered, to HEAD and GET, only with that server's
 * own token and only while the server's list carries it; a wrong token, another
 * server's id, a server without it, or a removed one all get a 404.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const FILE = "symbiote-neoforge-1.21.4.jar";
const SERVER = "01a0a00b-35c5-7932-861e-1b2161a9b298";
const OTHER_SERVER = "01a0a00b-35c5-7932-861e-1b2161a9b299";

const dir = mkdtempSync(join(tmpdir(), "polaris-pack-jar-"));
writeFileSync(join(dir, FILE), "symbiote-bytes");
process.env.POLARIS_MINECRAFT_MODS_DIR = dir;

const fake = vi.hoisted(() => ({ mods: "", installed: true }));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "test-secret" }) }));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async () =>
                fake.installed
                    ? { id: SERVER, name: "ExampleSMP", config: null, applicationId: "app-1" }
                    : null
        },
        envVar: {
            findFirst: async () => ({ value: fake.mods }),
            findMany: async () => [{ key: "MODS", value: fake.mods }]
        }
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: { readInstallConfig: () => ({}) },
        envVarService: { listEnvVars: async () => [], setEnvVars: async () => undefined },
        domainService: {
            appBaseUrl: async () => "https://polaris.example",
            requestOrigin: async () => "https://polaris.example"
        }
    }
}));

const { packToken } = await import("@polaris-app/game-servers/src/lib/minecraft/client-pack");
const route = await import(
    "@polaris-app/game-servers/src/routes/api/minecraft/pack/[id]/[token]/[file]/route"
);

const ask = (id: string, token: string) => ({
    request: new Request(`https://polaris.example/api/minecraft/pack/${id}/${token}/${FILE}`),
    context: { params: Promise.resolve({ id, token, file: FILE }) }
});

beforeEach(() => {
    fake.mods = `https://polaris.example/api/minecraft/pack/${SERVER}/${packToken(SERVER)}/${FILE}`;
    fake.installed = true;
});

describe("Symbiote through the pack link", () => {
    it("is served to the server's own token while its list carries it", async () => {
        const { request, context } = ask(SERVER, packToken(SERVER));
        const response = await route.GET(request, context);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/java-archive");
        expect(await response.text()).toBe("symbiote-bytes");
        const head = ask(SERVER, packToken(SERVER));
        expect((await route.HEAD(head.request, head.context)).status).toBe(200);
    });

    it("is not served with a wrong token or another server's", async () => {
        for (const token of ["nope", packToken(OTHER_SERVER), ""]) {
            const { request, context } = ask(SERVER, token);
            expect((await route.GET(request, context)).status, token).toBe(404);
        }
    });

    it("is not served to a server that does not carry it, or was removed", async () => {
        fake.mods = "https://example.com/other.jar";
        let { request, context } = ask(SERVER, packToken(SERVER));
        expect((await route.GET(request, context)).status).toBe(404);
        fake.mods = `https://polaris.example/api/minecraft/mod/${FILE}`;
        fake.installed = false;
        ({ request, context } = ask(SERVER, packToken(SERVER)));
        expect((await route.HEAD(request, context)).status).toBe(404);
    });
});
