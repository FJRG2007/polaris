import type { AddressInfo } from "node:net";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SESSION = "00000000-0000-4000-8000-00000000a001";
const placement = {
    current: {
        id: SESSION,
        place: "local" as "local" | "host",
        hostId: null as string | null,
        containerId: "127.0.0.1" as string | null,
        workdir: "/session/repo",
        state: "working"
    } as Record<string, unknown> | null
};

vi.mock("@polaris/config", async (original) => ({
    ...(await original<typeof import("@polaris/config")>()),
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "preview-test-secret-preview-test-secret" })
}));
vi.mock("@/lib/agents/session-service", () => ({
    sessionPlacement: async () => placement.current
}));
const remote = { forwarded: [] as string[], released: 0 };
vi.mock("@/lib/agents/session-ports", () => ({
    withContainerPorts: async (_host: string | null, work: (ports: unknown) => Promise<unknown>) =>
        work({
            inspect: async () => ({ NetworkSettings: { Networks: { bridge: { IPAddress: "127.0.0.1" } } } })
        })
}));
vi.mock("@/lib/connection-pool", () => ({
    borrowSsh: async () => ({
        client: {},
        release: () => {
            remote.released += 1;
        }
    })
}));
vi.mock("@/lib/host-service", () => ({
    getHostConnectionUnscoped: async () => ({ address: "198.51.100.7", port: 22, username: "u", auth: {}, hostKey: "k" })
}));
// The SSH channel, as a plain socket to the address the server would dial.
vi.mock("@polaris/ssh", async () => {
    const net = await import("node:net");
    return {
        forwardOut: (_client: unknown, host: string, port: number) =>
            new Promise((resolve, reject) => {
                remote.forwarded.push(`${host}:${port}`);
                const socket = net.connect(port, host, () => resolve(socket));
                socket.once("error", reject);
            })
    };
});

const preview = await import("@/lib/agents/session-preview");
const link = await import("@/lib/agents/session-preview-link");

describe("the ports a session serves", () => {
    it("tells the ones on every address from the ones on the container's loopback", () => {
        const proc = [
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
            "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1",
            "   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2",
            "   2: 0100007F:1F91 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 3",
            "   0: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 0A 0 0 0 0 0 4",
            "   1: 00000000000000000000000001000000:22B8 00000000000000000000000000000000:0000 0A 0 0 0 0 0 5",
            "   2: 0000000000000000FFFF00000100007F:0050 00000000000000000000000000000000:0000 0A 0 0 0 0 0 6"
        ].join("\n");
        // 3000 and 5173 on every address; 8080, 8888 and 80 on loopback only;
        // 8081 is a connection, not a server.
        expect(preview.listeningPorts(proc)).toEqual({ open: [3000, 5173], inside: [80, 8080, 8888] });
    });

    it("does not list a port as inside when it also listens everywhere", () => {
        const proc = [
            "0: 0100007F:0BB8 00000000:0000 0A 0 0 0 0 0 1",
            "1: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 0 0 0 0 0 2"
        ].join("\n");
        expect(preview.listeningPorts(proc)).toEqual({ open: [3000], inside: [] });
    });
});

describe("a preview's address", () => {
    it("is signed for one session and opens no other", () => {
        const base = link.previewBase(SESSION);
        const signature = base.split("/").at(-1)!;
        expect(base.startsWith(`/api/agents/preview/${SESSION}/`)).toBe(true);
        expect(link.readPreviewSignature(SESSION, signature)).toBe(true);
        expect(link.readPreviewSignature("00000000-0000-4000-8000-00000000a002", signature)).toBe(false);
        expect(link.readPreviewSignature(SESSION, `${signature.slice(0, -1)}A`)).toBe(signature.endsWith("A"));
        expect(link.readPreviewSignature(SESSION, "short")).toBe(false);
    });

    it("takes a port only in range", () => {
        expect(link.previewPort("3000")).toBe(3000);
        expect(link.previewPort("0")).toBeNull();
        expect(link.previewPort("65536")).toBeNull();
        expect(link.previewPort("30a")).toBeNull();
    });
});

describe("what crosses the preview", () => {
    it("never hands the reader's credentials to the agent's server", () => {
        const headers = new Headers({
            cookie: "polaris.session=secret",
            authorization: "Bearer secret",
            "x-forwarded-for": "203.0.113.9",
            accept: "text/html",
            connection: "keep-alive"
        });
        const out = preview.upstreamHeaders(headers, 5173, "/p", "https");
        expect(out.cookie).toBeUndefined();
        expect(out.authorization).toBeUndefined();
        expect(out.connection).toBeUndefined();
        expect(out["x-forwarded-for"]).toBeUndefined();
        expect(out).toMatchObject({
            accept: "text/html",
            host: "localhost:5173",
            "x-forwarded-prefix": "/p",
            "x-forwarded-proto": "https"
        });
    });

    it("never lets the page set a cookie or share Polaris's origin", () => {
        const upstream: IncomingHttpHeaders = {
            "set-cookie": ["polaris.session=stolen; Path=/"],
            "x-frame-options": "DENY",
            "content-security-policy": "default-src *",
            "content-type": "text/html"
        };
        const out = preview.downstreamHeaders(upstream, "/p/3000", "root");
        expect(out.get("set-cookie")).toBeNull();
        expect(out.get("x-frame-options")).toBeNull();
        expect(out.get("content-security-policy")).toBe(preview.PREVIEW_SANDBOX);
        expect(preview.PREVIEW_SANDBOX).not.toContain("allow-same-origin");
        expect(out.get("content-type")).toBe("text/html");
        expect(out.get("referrer-policy")).toBe("no-referrer");
    });

    it("keeps a redirect inside the preview", () => {
        expect(preview.previewLocation("/login", "/p/3000", "root")).toBe("/p/3000/login");
        expect(preview.previewLocation("http://localhost:3000/a?b=1", "/p/3000", "root")).toBe("/p/3000/a?b=1");
        expect(preview.previewLocation("/p/3000/next/", "/p/3000", "full")).toBe("/p/3000/next/");
        expect(preview.previewLocation("/other", "/p/3000", "full")).toBe("/p/3000/other");
        expect(preview.previewLocation("https://example.com/x", "/p/3000", "root")).toBe("https://example.com/x");
        expect(preview.previewLocation("next", "/p/3000", "root")).toBe("next");
    });

    it("asks the server at its root, or under the whole path", () => {
        expect(preview.upstreamPath("/p/3000/", "?a=1", "/p/3000", "root")).toBe("/?a=1");
        expect(preview.upstreamPath("/p/3000/x/y", "", "/p/3000", "root")).toBe("/x/y");
        expect(preview.upstreamPath("/p/3000/x", "", "/p/3000", "full")).toBe("/p/3000/x");
    });
});

describe("a preview served from a running server", () => {
    let server: Server;
    let port = 0;
    let seen: { url: string; headers: IncomingHttpHeaders }[] = [];
    let basePath = "";

    beforeAll(async () => {
        server = createServer((request, response) => {
            seen.push({ url: request.url ?? "", headers: request.headers });
            const url = request.url ?? "/";
            // Served under a base path when one is set, at the root otherwise,
            // the way a dev server given `--base` answers.
            const local = basePath ? (url.startsWith(basePath) ? url.slice(basePath.length - 1) : null) : url;
            if (local === null) {
                response.writeHead(404).end("not here");
                return;
            }
            if (local === "/go") {
                response.writeHead(302, { location: "/landed" }).end();
                return;
            }
            if (request.method === "POST") {
                let body = "";
                request.on("data", (chunk) => (body += chunk));
                request.on("end", () => response.writeHead(201).end(`got ${body}`));
                return;
            }
            response.writeHead(200, { "content-type": "text/plain", "set-cookie": "a=b" }).end(`page ${local}`);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
    beforeEach(() => {
        seen = [];
        basePath = "";
        placement.current = {
            id: SESSION,
            place: "local",
            hostId: null,
            containerId: "127.0.0.1",
            workdir: "/session/repo",
            state: "working"
        };
    });

    const ask = (path: string, init: { method?: string; body?: string; cookie?: string } = {}, now = Date.now()) => {
        const prefix = `${link.previewBase(SESSION)}/${port}`;
        const url = new URL(`http://polaris.test${prefix}${path}`);
        return preview.proxyPreview(
            {
                sessionId: SESSION,
                port,
                pathname: url.pathname,
                search: url.search,
                method: init.method ?? "GET",
                headers: new Headers(init.cookie ? { cookie: init.cookie } : {}),
                body: init.body ? (new Response(init.body).body as ReadableStream<Uint8Array>) : null,
                signal: new AbortController().signal,
                proto: "https"
            },
            now
        );
    };

    it("answers from a server at its root, without the reader's cookie", async () => {
        const response = await ask("/hello?x=1", { cookie: "polaris.session=secret" }, 1);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("page /hello?x=1");
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(seen[0]!.headers.cookie).toBeUndefined();
        expect(seen[0]!.headers.host).toBe(`localhost:${port}`);
    });

    it("finds a server started under the preview's path", async () => {
        basePath = `${link.previewBase(SESSION)}/${port}/`;
        // A moment the root mode is not remembered for.
        const response = await ask("/app", {}, 10_000_000);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("page /app");
        expect(seen.map((one) => one.url)).toEqual(["/app", `${basePath}app`]);
    });

    it("keeps a redirect inside the preview", async () => {
        const response = await ask("/go", {}, 20_000_000);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(`${link.previewBase(SESSION)}/${port}/landed`);
    });

    it("sends a write once, with its body", async () => {
        const response = await ask("/form", { method: "POST", body: "a=1" }, 30_000_000);
        expect(response.status).toBe(201);
        expect(await response.text()).toBe("got a=1");
        expect(seen).toHaveLength(1);
    });

    it("says nothing answers on a port with no server", async () => {
        const closed = createServer();
        await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
        const free = (closed.address() as AddressInfo).port;
        await new Promise<void>((resolve) => closed.close(() => resolve()));
        const url = `${link.previewBase(SESSION)}/${free}/`;
        await expect(
            preview.proxyPreview(
                {
                    sessionId: SESSION,
                    port: free,
                    pathname: url,
                    search: "",
                    method: "GET",
                    headers: new Headers(),
                    body: null,
                    signal: new AbortController().signal,
                    proto: "https"
                },
                40_000_000
            )
        ).rejects.toMatchObject({ failure: "refused" });
    });

    it("reaches a session on a pool server through that server", async () => {
        placement.current = { ...placement.current!, hostId: "00000000-0000-4000-8000-00000000b001", containerId: "polaris-session-x" };
        remote.forwarded = [];
        remote.released = 0;
        const response = await ask("/remote", {}, 70_000_000);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("page /remote");
        expect(remote.forwarded).toEqual([`127.0.0.1:${port}`]);
        expect(remote.released).toBe(1);
    });

    it("opens nothing for a session that is over or on somebody's own account", async () => {
        placement.current = { ...placement.current!, state: "stopped" };
        await expect(ask("/", {}, 80_000_000)).rejects.toMatchObject({ failure: "gone" });
        placement.current = { ...placement.current!, state: "working", place: "host" };
        await expect(ask("/", {}, 90_000_000)).rejects.toMatchObject({ failure: "gone" });
    });
});
