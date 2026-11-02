import { afterEach, describe, expect, it } from "vitest";
import { createServer, type AddressInfo, type Server } from "node:net";
import {
    answerFor,
    askHelper,
    deviceNameFrom,
    elevatedInstall,
    joinSchema,
    tailscalePath
} from "@/main/vpn-helper-client";

const SECRET = "secret";
let server: Server | null = null;

afterEach(() => server?.close());

/** A stand-in for the service: a challenge, then a reply built from what came back. */
async function helper(reply: (order: Record<string, unknown>) => string): Promise<number> {
    server = createServer((socket) => {
        socket.write(`${JSON.stringify({ nonce: "abc" })}\n`);
        socket.on("data", (chunk) => {
            socket.write(`${reply(JSON.parse(chunk.toString()) as Record<string, unknown>)}\n`);
        });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
}

describe("askHelper", () => {
    it("answers the challenge and never sends the secret", async () => {
        let seen: Record<string, unknown> = {};
        const port = await helper((order) => {
            seen = order;
            return JSON.stringify({ ok: true, version: 1, nodeId: null });
        });
        expect(await askHelper({ order: "status" }, SECRET, port)).toEqual({
            ok: true,
            version: 1,
            nodeId: null
        });
        expect(seen.answer).toBe(answerFor(SECRET, "abc"));
        expect(JSON.stringify(seen)).not.toContain(SECRET);
    });

    it("is null when nothing listens", async () => {
        const port = await helper(() => "{}");
        await new Promise((resolve) => server?.close(resolve));
        expect(await askHelper({ order: "status" }, SECRET, port)).toBeNull();
    });

    it("is null on an answer that is not one", async () => {
        const port = await helper(() => "not json");
        expect(await askHelper({ order: "status" }, SECRET, port)).toBeNull();
    });
});

describe("elevatedInstall", () => {
    it("keeps paths out of the script on Windows", () => {
        const launch = elevatedInstall("win32", "C:\\a'b\\h.exe", "C:\\s");
        expect(launch.file).toBe("powershell.exe");
        expect(launch.args.join(" ")).not.toContain("a'b");
        expect(launch.env?.POLARIS_VPN_HELPER).toBe("C:\\a'b\\h.exe");
    });

    it("keeps paths out of the script on macOS", () => {
        const launch = elevatedInstall("darwin", "/Apps/a\"b/h", "/s");
        expect(launch.args.join(" ")).not.toContain('a"b');
    });

    it("hands Linux an argument list", () => {
        expect(elevatedInstall("linux", "/h", "/s")).toEqual({
            file: "pkexec",
            args: ["/h", "install", "/s"]
        });
    });
});

describe("joinSchema", () => {
    it("takes a server and a one-time key", () => {
        expect(joinSchema.safeParse({ server: "https://vpn.example.com", key: "abcd1234" }).success).toBe(true);
    });

    it("refuses another scheme and a key with spaces", () => {
        expect(joinSchema.safeParse({ server: "file:///etc/passwd", key: "abcd1234" }).success).toBe(false);
        expect(joinSchema.safeParse({ server: "https://x", key: "a b c d e f g" }).success).toBe(false);
    });
});

describe("small things", () => {
    it("names the client for each system", () => {
        expect(tailscalePath("win32")).toContain("tailscale.exe");
        expect(tailscalePath("linux")).toBe("tailscale");
    });

    it("makes a device name out of any hostname", () => {
        expect(deviceNameFrom("DESKTOP-ABC123")).toBe("DESKTOP-ABC123");
        expect(deviceNameFrom("***")).toBe("Computer");
        expect(deviceNameFrom("a".repeat(60))).toHaveLength(40);
    });
});
