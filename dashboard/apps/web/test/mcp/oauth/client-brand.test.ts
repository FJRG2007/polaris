/**
 * Which connected apps get a brand's mark. The name is the app's own claim,
 * so it only counts when every address the app returns to is this computer or
 * the brand's own domain.
 */

import { describe, expect, it } from "vitest";
import { clientBrand } from "@/lib/mcp/oauth/client-brand";

describe("recognising a connected app", () => {
    it("names the local tools that sign in through this computer", () => {
        expect(clientBrand("Claude Code", ["http://localhost:53124/callback"])).toBe("claude-code");
        expect(clientBrand("Claude Code (polaris)", ["http://127.0.0.1/callback"])).toBe(
            "claude-code"
        );
        expect(clientBrand("Visual Studio Code", ["http://127.0.0.1:33418/"])).toBe("vscode");
        expect(clientBrand("Cursor", ["http://localhost/cb"])).toBe("cursor");
    });

    it("names a hosted assistant only on its own domain", () => {
        expect(clientBrand("Claude", ["https://claude.ai/api/mcp/auth_callback"])).toBe("claude");
        expect(
            clientBrand("ChatGPT", ["https://chatgpt.com/connector_platform_oauth_redirect"])
        ).toBe("chatgpt");
        expect(clientBrand("VS Code", ["https://vscode.dev/redirect"])).toBe("vscode");
    });

    it("gives a borrowed name no mark", () => {
        expect(clientBrand("ChatGPT", ["https://chatgpt.com.example.test/cb"])).toBeNull();
        expect(
            clientBrand("Claude", ["https://claude.ai/cb", "https://example.test/cb"])
        ).toBeNull();
        expect(clientBrand("Cursor", ["http://cursor.com/cb"])).toBeNull();
        expect(clientBrand("Zed", ["http://127.0.0.1/cb"])).toBeNull();
        expect(clientBrand("", ["http://127.0.0.1/cb"])).toBeNull();
        expect(clientBrand("Claude", [])).toBeNull();
    });
});
