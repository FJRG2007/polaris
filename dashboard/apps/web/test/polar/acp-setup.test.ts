// @vitest-environment node
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createApiKeySchema } from "@polaris/core";
import { createServer, type Server } from "node:http";
import { NATIVE_BUNDLE_ROUTE } from "@/lib/polar/native/bundle";
import { ACP_BUNDLE_ROUTE, ACP_KEY_PLACEHOLDER, acpCommand, acpSnippet } from "@/lib/polar/acp-setup";

describe("editor setup for Polar over ACP", () => {
    it("downloads from the route the instance serves the bundle on", () => {
        expect(ACP_BUNDLE_ROUTE).toBe(NATIVE_BUNDLE_ROUTE);
    });

    it("writes Zed's agent_servers block for this instance", () => {
        const zed = JSON.parse(acpSnippet("zed", "https://polaris.example.test/")) as {
            agent_servers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }>;
        };
        const polar = zed.agent_servers.Polar!;
        expect(polar.type).toBe("custom");
        expect(polar.command).toBe("node");
        expect(polar.args.slice(0, 2)).toEqual(["--input-type=module", "-e"]);
        expect(polar.env).toEqual({ POLARIS_URL: "https://polaris.example.test", POLARIS_API_KEY: ACP_KEY_PLACEHOLDER });
    });

    it("writes JetBrains' acp.json block and the plain command, with a key when one was made", () => {
        const jetbrains = JSON.parse(acpSnippet("jetbrains", "https://polaris.example.test", "pk_test_key")) as {
            agent_servers: Record<string, { type?: string; env: Record<string, string> }>;
        };
        expect(jetbrains.agent_servers.Polar!.type).toBeUndefined();
        expect(jetbrains.agent_servers.Polar!.env.POLARIS_API_KEY).toBe("pk_test_key");
        const other = JSON.parse(acpSnippet("other", "https://polaris.example.test")) as { command: string; args: string[] };
        expect(other.command).toBe("node");
        expect(other.args).toHaveLength(3);
    });

    it("the key the screen creates passes the key schema", () => {
        expect(createApiKeySchema.safeParse({ name: "Polar in an editor", scopes: ["polar.use"] }).success).toBe(true);
    });

    it("the loader fetches, checks, keeps and runs the bundle with the acp argument", async () => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), "polar-acp-loader-"));
        // A stand-in bundle that reports what it was started with.
        const bundle = Buffer.from('console.log(JSON.stringify({ argv: process.argv.slice(2), url: process.env.POLARIS_URL }));\n');
        const server: Server = createServer((request, response) => {
            if (request.url !== ACP_BUNDLE_ROUTE) {
                response.writeHead(404).end();
                return;
            }
            response.writeHead(200, { "x-content-sha256": createHash("sha256").update(bundle).digest("hex") });
            response.end(bundle);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as { port: number }).port;
        const url = `http://127.0.0.1:${port}`;
        const run = acpCommand(url, "pk_test_key");
        try {
            const output = await new Promise<string>((resolve, reject) => {
                const child = spawn(process.execPath, [...run.args], {
                    env: { ...process.env, ...run.env, HOME: home, USERPROFILE: home },
                    stdio: ["ignore", "pipe", "pipe"]
                });
                let out = "";
                let err = "";
                child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
                child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
                child.on("error", reject);
                child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
            });
            expect(JSON.parse(output.trim())).toEqual({ argv: ["acp"], url });
            const kept = await fs.readFile(path.join(home, ".polaris-agent", "polaris-agent.mjs"));
            expect(kept.equals(bundle)).toBe(true);
        } finally {
            await new Promise((resolve) => server.close(resolve));
            await fs.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        }
    }, 30_000);
});
