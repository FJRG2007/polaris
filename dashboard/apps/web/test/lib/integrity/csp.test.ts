import { describe, expect, it, vi } from "vitest";
import { cspNonce, strictCsp } from "@/lib/integrity/csp";
import { POST } from "@/app/api/csp-report/route";

describe("strict script policy", () => {
    it("gives each response its own nonce and allows only nonced scripts", () => {
        const a = cspNonce();
        expect(a).not.toBe(cspNonce());
        expect(atob(a)).toHaveLength(16);
        const policy = strictCsp(a);
        expect(policy).toContain(`script-src 'nonce-${a}' 'strict-dynamic'`);
        expect(policy).toContain("object-src 'none'");
        expect(policy).toContain("report-uri /api/csp-report");
    });

    it("logs a report without its query string, and ignores junk", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const report = {
            "csp-report": {
                "document-uri": "https://polaris.example/chat?token=secret",
                "effective-directive": "script-src-elem",
                "blocked-uri": "inline"
            }
        };
        expect((await POST(new Request("http://x/api/csp-report", { method: "POST", body: JSON.stringify(report) }))).status).toBe(204);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).not.toContain("secret");
        await POST(new Request("http://x/api/csp-report", { method: "POST", body: "not json" }));
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
});
