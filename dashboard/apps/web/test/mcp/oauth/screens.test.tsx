/**
 * The three screens of connecting an assistant, rendered in both languages:
 * the consent card, the connected-assistants list, and the setup steps. What
 * is pinned is what a person relies on - the return address shown beside the
 * app's own claimed name, the loopback warning, a box per scope, a mark that
 * only a recognised app gets, a Disconnect per app, and per client the exact
 * value to paste.
 */

import { withMessages } from "../../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const locale = vi.hoisted(() => ({ current: "en-US" as "en-US" | "es-ES" }));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/app/oauth/authorize/actions", () => ({ answerAuthorizationAction: vi.fn() }));
vi.mock("@/app/(app)/account/assistants/connected-app-actions", () => ({
    disconnectAppAction: vi.fn(),
    changeAppScopesAction: vi.fn()
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/mcp/oauth/origin", () => ({
    currentOrigin: async () => "https://polaris.example.test"
}));
vi.mock("@/lib/i18n/request", async () => {
    const { translatorFor } = await import("@/lib/i18n/translate");
    return {
        getTranslations: async (namespace: "mcp") => translatorFor(locale.current, namespace)
    };
});

const { ConsentView } = await import("@/app/oauth/authorize/consent-view");
const { ConnectedApps } = await import("@/app/(app)/account/assistants/connected-apps");
const { McpAssistants } = await import("@/app/(app)/account/assistants/mcp-assistants");

describe("the consent card", () => {
    const props = {
        query: "client_id=x",
        app: {
            name: "Claude",
            brand: null,
            website: "claude.ai",
            returnsTo: "claude.ai",
            loopback: false
        },
        person: "Ada",
        offered: ["tasks.read", "tasks.manage"] as never,
        withheld: ["users.manage"] as never
    };

    it("shows the name, where it returns to, a box per scope and what was withheld", () => {
        const html = renderToStaticMarkup(withMessages(<ConsentView {...props} />));
        expect(html).toContain("Connect Claude to Polaris");
        expect(html).toContain("Sends you back to");
        expect(html).toContain("claude.ai");
        expect(html).toContain("Read spaces, lists and tasks");
        expect(html).toContain("Create and change tasks");
        expect((html.match(/type="checkbox"/g) ?? []).length).toBe(2);
        expect(html).toContain("your account cannot: Manage users");
        expect(html).not.toContain("runs on this computer");
    });

    it("warns about an app on this computer, and falls back for an unnamed one", () => {
        const html = renderToStaticMarkup(
            withMessages(
                <ConsentView
                    {...props}
                    app={{ ...props.app, name: "", loopback: true, returnsTo: "127.0.0.1" }}
                />
            )
        );
        expect(html).toContain("This app runs on this computer");
        expect(html).toContain("Connect An unnamed app to Polaris");
    });

    it("draws a recognised assistant's own mark instead of the generic glyph", () => {
        const plain = renderToStaticMarkup(withMessages(<ConsentView {...props} />));
        const branded = renderToStaticMarkup(
            withMessages(<ConsentView {...props} app={{ ...props.app, brand: "vscode" }} />)
        );
        expect(plain).not.toContain('src="/logos/vscode.svg"');
        expect(branded).toContain('src="/logos/vscode.svg"');
    });

    it("reads in Spanish", () => {
        const html = renderToStaticMarkup(withMessages(<ConsentView {...props} />, "es-ES"));
        expect(html).toContain("Conectar Claude a Polaris");
        expect(html).toContain("Permitir");
    });
});

describe("the connected-assistants list", () => {
    const app = {
        id: "g1",
        name: "Visual Studio Code",
        clientUri: null,
        redirectHost: "127.0.0.1",
        brand: "vscode" as const,
        scopes: ["tasks.read", "tasks.manage", "notes.use"],
        requestable: ["tasks.read", "tasks.manage", "notes.use"],
        offered: ["tasks.read", "tasks.manage", "notes.use"] as never,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        lastUsedIp: null
    };

    it("lists each app with its mark, return address, a permission count and its actions", () => {
        const html = renderToStaticMarkup(withMessages(<ConnectedApps apps={[app]} />));
        expect(html).toContain("Visual Studio Code");
        expect(html).toContain('src="/logos/vscode.svg"');
        expect(html).toContain("Returns to 127.0.0.1");
        expect(html).toContain("3 permissions");
        // Collapsed: the count, not a chip per permission.
        expect(html).not.toContain("Read spaces, lists and tasks");
        expect(html).toContain('aria-label="Change permissions for Visual Studio Code"');
        expect(html).toContain('aria-label="Disconnect Visual Studio Code"');
        expect(html).toContain("Not used yet");
        expect(html).toContain("Not used in the last 7 days");
        expect(html).not.toContain('type="search"');
    });

    it("draws an initial for an app it does not recognise", () => {
        const html = renderToStaticMarkup(
            withMessages(<ConnectedApps apps={[{ ...app, name: "zed", brand: null }]} />)
        );
        expect(html).not.toContain("/logos/vscode.svg");
        expect(html).toMatch(/aria-hidden="true">z<\/span>/);
    });

    it("marks an app used this week, and offers a search past six apps", () => {
        const recent = { ...app, lastUsedAt: new Date().toISOString(), lastUsedIp: "203.0.113.9" };
        const many = Array.from({ length: 7 }, (_, index) => ({ ...recent, id: `g${index}` }));
        const html = renderToStaticMarkup(withMessages(<ConnectedApps apps={many} />));
        expect(html).toContain("Used in the last 7 days");
        expect(html).toContain("203.0.113.9");
        expect(html).toContain('type="search"');
    });

    it("says how to connect one when there are none", () => {
        const html = renderToStaticMarkup(withMessages(<ConnectedApps apps={[]} />));
        expect(html).toContain("No assistants connected yet");
        expect(html).toContain('href="#connect"');
    });

    it("reads in Spanish", () => {
        const html = renderToStaticMarkup(withMessages(<ConnectedApps apps={[app]} />, "es-ES"));
        expect(html).toContain("Asistentes conectados");
        expect(html).toContain("3 permisos");
    });
});

describe("the setup steps", () => {
    it("gives every client the server URL in the form it takes", async () => {
        locale.current = "en-US";
        const html = renderToStaticMarkup(withMessages(await McpAssistants()));
        const url = "https://polaris.example.test/api/mcp";
        expect(html).toContain(url);
        expect(html).toContain(`claude mcp add --transport http polaris ${url}`);
        expect(html).toContain(
            'href="cursor://anysphere.cursor-deeplink/mcp/install?name=polaris&amp;config='
        );
        expect(html).toContain('href="vscode:mcp/install?');
        expect(html).toContain('href="https://claude.ai/customize/connectors"');
        for (const name of [
            "Claude Code",
            "Claude (web and desktop)",
            "ChatGPT",
            "Cursor",
            "Visual Studio Code"
        ]) {
            expect(html).toContain(name);
        }
        expect(html).toContain('src="/logos/vscode.svg"');
        expect(html).toContain("Create MCP App");
        expect(html).toContain("Set Authentication to OAuth");
        expect(html).toContain(
            'href="https://developers.openai.com/api/docs/guides/developer-mode"'
        );
    });

    it("reads in Spanish", async () => {
        locale.current = "es-ES";
        const html = renderToStaticMarkup(withMessages(await McpAssistants(), "es-ES"));
        expect(html).toContain("Conectar un asistente");
        locale.current = "en-US";
    });
});
