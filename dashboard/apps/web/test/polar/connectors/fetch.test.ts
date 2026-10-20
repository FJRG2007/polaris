import { describe, expect, it } from "vitest";
import { RefusedAddressError } from "@/lib/safe-fetch";
import { cappedBody, connectorFetch } from "@/lib/polar/connectors/fetch";

describe("connector fetch", () => {
    it("refuses private and metadata addresses unless the administrator allowed them", async () => {
        const fetch = connectorFetch({ allowPrivate: false });
        for (const address of [
            "http://127.0.0.1:8080/mcp",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/mcp",
            "https://10.0.0.2/mcp",
            "file:///etc/passwd",
            "https://user:pass@example.com/mcp"
        ]) {
            await expect(fetch(address, { method: "POST" })).rejects.toThrow(RefusedAddressError);
        }
    });

    it("answers the listening stream itself instead of holding one open", async () => {
        const fetch = connectorFetch({ allowPrivate: false, listen: false });
        const response = await fetch("https://mcp.example.com/mcp", {
            method: "GET",
            headers: { accept: "text/event-stream" }
        });
        expect(response.status).toBe(405);
    });

    it("cuts a body off past its ceiling", async () => {
        const source = new Response("x".repeat(100)).body!;
        await expect(new Response(cappedBody(source, 10)).text()).rejects.toThrow();
        const small = new Response("x".repeat(5)).body!;
        await expect(new Response(cappedBody(small, 10)).text()).resolves.toBe("xxxxx");
    });
});
