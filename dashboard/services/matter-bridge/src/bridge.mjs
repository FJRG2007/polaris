/**
 * The Matter bridge: a Matter controller for cameras, and the door the camera
 * relay dials to watch one.
 *
 * It runs the OHF Matter.js server on loopback, so nothing but this process can
 * reach the fabric, and puts two things in front of it:
 *
 * - A small HTTP API for Polaris (account and password set at install): add a
 *   camera with the pairing code its own app shares, read what it can do, and
 *   take it off this fabric again.
 * - A WebSocket per camera that speaks go2rtc's own WebRTC signalling. The relay
 *   holds the one WebRTC connection to the camera through it and re-serves it as
 *   it does every other camera, so a viewer only ever gets a Polaris address.
 *
 * Sockets and processes only; every translation lives in signaling.mjs.
 */

import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
    canTalk,
    cameraEndpoint,
    cameraPath,
    candidateArgs,
    commissionRefusal,
    firstMid,
    parseRelayMessage,
    relayMessagesFor,
    startStreamArgs
} from "./signaling.mjs";

const PORT = 5590;
const MATTER_PORT = 5580;
const USERNAME = process.env.BRIDGE_USERNAME || "polaris";
const PASSWORD = process.env.BRIDGE_PASSWORD || "";
const REQUEST_TIMEOUT_MS = 30_000;
const COMMISSION_TIMEOUT_MS = 180_000;
const MAX_BODY_BYTES = 4096;

if (PASSWORD.length < 16) {
    console.error("BRIDGE_PASSWORD is missing; refusing to start with an open API");
    process.exit(1);
}

// The Matter server, bound to loopback: its API has no account of its own.
const matter = spawn(
    process.execPath,
    ["--enable-source-maps", "/app/node_modules/matter-server/dist/esm/MatterServer.js"],
    {
        env: {
            ...process.env,
            LISTEN_ADDRESS: "127.0.0.1",
            PORT: String(MATTER_PORT),
            STORAGE_PATH: "/data"
        },
        stdio: "inherit"
    }
);
matter.on("exit", (code) => {
    console.error(`The Matter server stopped (${code}); stopping with it`);
    process.exit(1);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
        matter.kill("SIGTERM");
        process.exit(0);
    });
}

/** One connection to the Matter server, redialled when it drops. */
const server = {
    socket: /** @type {WebSocket | null} */ (null),
    ready: false,
    pending: new Map(),
    listeners: new Set()
};

function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${MATTER_PORT}/ws`);
    server.socket = socket;
    socket.addEventListener("message", (event) => {
        let frame;
        try {
            frame = JSON.parse(String(event.data));
        } catch {
            return;
        }
        if (frame && "fabric_id" in frame && "schema_version" in frame) {
            server.ready = true;
            return;
        }
        if (frame?.message_id && server.pending.has(frame.message_id)) {
            const { resolve, timer } = server.pending.get(frame.message_id);
            clearTimeout(timer);
            server.pending.delete(frame.message_id);
            resolve(frame);
            return;
        }
        if (frame?.event) for (const listener of server.listeners) listener(frame);
    });
    socket.addEventListener("close", () => {
        server.ready = false;
        for (const { resolve, timer } of server.pending.values()) {
            clearTimeout(timer);
            resolve({ error_code: -1, details: "The Matter server went away" });
        }
        server.pending.clear();
        setTimeout(connect, 2000);
    });
    socket.addEventListener("error", () => socket.close());
}
setTimeout(connect, 1000);

/** One command; answers the server's frame, error or not. */
function command(name, args, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve) => {
        if (!server.ready || server.socket?.readyState !== WebSocket.OPEN) {
            resolve({ error_code: -1, details: "The Matter server is still starting" });
            return;
        }
        const id = randomUUID();
        const timer = setTimeout(() => {
            server.pending.delete(id);
            resolve({ error_code: -1, details: "The Matter server did not answer in time" });
        }, timeoutMs);
        server.pending.set(id, { resolve, timer });
        server.socket.send(JSON.stringify({ message_id: id, command: name, args }));
    });
}

function sameSecret(given, expected) {
    const a = Buffer.from(String(given ?? ""));
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(header) {
    return sameSecret(header, `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`);
}

function reply(response, status, body) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}

async function readJson(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return null;
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        return null;
    }
}

/**
 * Add a camera with the code its own app shared. The code is decoded first so
 * the camera can be asked for at the address Polaris already knows: without the
 * host's network this container sees no multicast, so an address is how it is
 * found.
 */
async function commission(body) {
    const code = typeof body?.code === "string" ? body.code.replace(/[\s-]/g, "") : "";
    const address = typeof body?.address === "string" ? body.address.trim() : "";
    if (!/^(\d{11}|\d{21}|MT:[0-9A-Z.-]{19,})$/.test(code))
        return { status: 400, body: { error: "invalid-payload" } };
    const parsed = await command("parse_onboarding_payload", { code });
    if (parsed.error_code !== undefined)
        return { status: 400, body: { error: commissionRefusal(parsed.reason ?? "invalid-payload") } };
    const payload = parsed.result?.type === "qr" ? parsed.result.payloads?.[0] : parsed.result;
    const pin = payload?.setup_pin_code;
    if (typeof pin !== "number") return { status: 400, body: { error: "invalid-payload" } };
    const filter =
        typeof payload.discriminator === "number"
            ? { filter_type: 2, filter: payload.discriminator }
            : typeof payload.short_discriminator === "number"
              ? { filter_type: 1, filter: payload.short_discriminator }
              : { filter_type: 0 };
    const answer = await command(
        "commission_on_network",
        {
            setup_pin_code: pin,
            ...filter,
            ...(address ? { ip_addr: address } : {}),
            discovery_timeout_s: 120
        },
        COMMISSION_TIMEOUT_MS
    );
    if (answer.error_code !== undefined)
        return { status: 502, body: { error: commissionRefusal(answer.reason) } };
    const nodeId = answer.result?.node_id;
    const endpointId = cameraEndpoint(answer.result?.attributes);
    if (typeof nodeId !== "number") return { status: 502, body: { error: "failed" } };
    if (endpointId === null) {
        // Not a camera: taken off this fabric again rather than kept.
        await command("remove_node", { node_id: nodeId });
        return { status: 422, body: { error: "not-a-camera" } };
    }
    return { status: 200, body: { nodeId, endpointId } };
}

async function capabilities(target) {
    const answer = await command("camera_get_capabilities", {
        node_id: target.nodeId,
        endpoint_id: target.endpointId
    });
    if (answer.error_code !== undefined) return { status: 502, body: { error: "unreachable" } };
    return { status: 200, body: { talk: canTalk(answer.result) } };
}

const http = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://bridge");
    if (url.pathname === "/health")
        return reply(response, server.ready ? 200 : 503, { ready: server.ready });
    if (!authorized(request.headers.authorization))
        return reply(response, 401, { error: "unauthorized" });
    if (request.method === "POST" && url.pathname === "/commission") {
        const result = await commission(await readJson(request));
        return reply(response, result.status, result.body);
    }
    const target = cameraPath(url.pathname);
    if (target && request.method === "GET" && target.rest === "/capabilities") {
        const result = await capabilities(target);
        return reply(response, result.status, result.body);
    }
    if (target && request.method === "DELETE" && target.rest === "") {
        const answer = await command("remove_node", { node_id: target.nodeId });
        return reply(response, answer.error_code === undefined ? 200 : 502, {});
    }
    return reply(response, 404, { error: "not-found" });
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

http.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://bridge");
    const target = cameraPath(url.pathname);
    if (!target || target.rest !== "/webrtc" || !sameSecret(url.searchParams.get("token"), PASSWORD)) {
        socket.destroy();
        return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => relaySession(ws, target));
});

/** One relay connection: one WebRTC session with one camera. */
function relaySession(ws, target) {
    const key = randomUUID();
    let started = false;
    let mid = "0";
    const listener = (frame) => {
        const outcome = relayMessagesFor(frame, key);
        if (outcome === "end") ws.close();
        else if (outcome) for (const message of outcome.send) ws.send(JSON.stringify(message));
    };
    server.listeners.add(listener);
    ws.on("message", async (data) => {
        const message = parseRelayMessage(String(data));
        if (!message) return;
        if (message.type === "candidate") {
            // Sent as soon as the start is under way: the server queues a
            // candidate named by the key until the session exists.
            if (started)
                void command(
                    "camera_provide_ice_candidates",
                    candidateArgs(target, key, message.candidate, mid)
                );
            return;
        }
        if (started) return;
        started = true;
        mid = firstMid(message.sdp);
        const caps = await capabilities(target);
        const answer = await command(
            "camera_start_stream",
            startStreamArgs(target, message.sdp, key, caps.body.talk === true),
            COMMISSION_TIMEOUT_MS
        );
        if (answer.error_code !== undefined) {
            console.error(
                `camera_start_stream for node ${target.nodeId} failed: ${answer.details ?? answer.error_code}`
            );
            ws.close(1011, "camera refused");
        }
    });
    ws.on("close", () => {
        server.listeners.delete(listener);
        if (started)
            void command("camera_stop_stream", {
                node_id: target.nodeId,
                endpoint_id: target.endpointId,
                client_session_key: key
            });
    });
}

http.listen(PORT, "0.0.0.0", () => console.log(`Matter bridge listening on ${PORT}`));
