/**
 * Two screens of connecting an assistant, rendered in both languages: the
 * consent card and the connected-assistants list. What is pinned is what a
 * person relies on - the return address shown beside the app's own claimed
 * name, the loopback warning, a box per scope, a mark that only a recognised
 * app gets, and a Disconnect per app. The setup guides are pinned in
 * test/mcp/connect-guides.test.tsx.
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
const { McpScopeChecklist } = await import("@/components/mcp-scope-checklist");

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

    it("leaves what reaches outside Polaris unticked until the person ticks it", () => {
        const html = renderToStaticMarkup(
            withMessages(
                <ConsentView
                    {...props}
                    offered={["mail.read", "mail.send", "places.control"] as never}
                    withheld={[]}
                />
            )
        );
        expect(html).toContain("Read and search your mail");
        expect(html).toContain("Send mail as you");
        expect(html).toContain("Operate devices: switch, lock, set");
        // One box of three is ticked: reading.
        expect((html.match(/type="checkbox"/g) ?? []).length).toBe(3);
        expect((html.match(/checked=""/g) ?? []).length).toBe(1);
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
        unrequested: [] as never,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        lastUsedIp: null,
        ipPolicy: { mode: "none" as const, allow: [], deny: [] },
        approvedIp: "203.0.113.5",
        lastRefusedAt: null,
        lastRefusedIp: null,
        networkException: { allowedCountries: [], allowedContinents: [], allowedCidrs: [], presets: [] }
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

    it("says where an app may connect from, and when its rule refused it", () => {
        const html = renderToStaticMarkup(
            withMessages(
                <ConnectedApps
                    apps={[
                        {
                            ...app,
                            ipPolicy: { mode: "origin", allow: [], deny: [] },
                            lastRefusedAt: new Date().toISOString(),
                            lastRefusedIp: "198.51.100.20"
                        }
                    ]}
                />
            )
        );
        expect(html).toContain("Only from 203.0.113.5");
        expect(html).toContain("198.51.100.20");
        expect(html).toContain('aria-label="Where Visual Studio Code may connect from"');
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

    it("says nothing about network rules to an account that has none", () => {
        for (const language of ["en-US", "es-ES"] as const) {
            const html = renderToStaticMarkup(
                withMessages(<ConnectedApps apps={[app]} canExcept />, language)
            );
            expect(html).not.toContain('role="note"');
            expect(html).not.toContain("/account/access");
        }
    });

    it("tells a restricted account why assistants on their own servers are refused, and how to allow one", () => {
        const html = renderToStaticMarkup(
            withMessages(<ConnectedApps apps={[app]} restricted canExcept />)
        );
        expect(html).toContain('role="note"');
        expect(html).toContain("assistants that call from their own servers, such as ChatGPT");
        expect(html).toContain("Also allow from");
        expect(html).toContain("Allow Visual Studio Code");
        expect(html).toContain('href="/account/access"');

        const spanish = renderToStaticMarkup(
            withMessages(<ConnectedApps apps={[app]} restricted canExcept />, "es-ES")
        );
        expect(spanish).toContain("desde sus propios servidores");
        expect(spanish).toContain("Permitir Visual Studio Code");
    });

    it("tells somebody who is not an administrator that only one can allow it", () => {
        const html = renderToStaticMarkup(withMessages(<ConnectedApps apps={[app]} restricted />));
        expect(html).toContain("Only an administrator can let a connection past these rules.");
        expect(html).not.toContain("Allow Visual Studio Code");
    });

    it("names where a connection is also allowed from", () => {
        const excepted = {
            ...app,
            networkException: {
                allowedCountries: ["US"],
                allowedContinents: [],
                allowedCidrs: ["198.51.100.0/24"],
                presets: ["openai" as const]
            }
        };
        const html = renderToStaticMarkup(withMessages(<ConnectedApps apps={[excepted]} />));
        expect(html).toContain(
            "Also allowed from: OpenAI&#x27;s addresses, United States, 198.51.100.0/24"
        );
        const spanish = renderToStaticMarkup(
            withMessages(<ConnectedApps apps={[excepted]} />, "es-ES")
        );
        expect(spanish).toContain("También permitido desde: Direcciones de OpenAI, Estados Unidos");
    });
});

describe("the boxes an app's permissions are changed with", () => {
    it("marks what the app never asked for, and ticks none of it", () => {
        const toggle = vi.fn();
        const html = renderToStaticMarkup(
            withMessages(
                <McpScopeChecklist
                    offered={["tasks.read", "mail.read", "calendar.manage"]}
                    selected={["tasks.read"]}
                    effective={new Set(["tasks.read"])}
                    unrequested={new Set(["mail.read", "calendar.manage"])}
                    onToggle={toggle}
                />
            )
        );
        expect((html.match(/Not asked for by this app/g) ?? []).length).toBe(2);
        expect((html.match(/checked=""/g) ?? []).length).toBe(1);
        expect(html).toContain("Create, change and delete events");
        // Drawing the boxes changes nothing: only a click does.
        expect(toggle).not.toHaveBeenCalled();
    });

    it("says that a reading scope comes with the managing one", () => {
        const toggle = vi.fn();
        const html = renderToStaticMarkup(
            withMessages(
                <McpScopeChecklist
                    offered={["calendar.read", "calendar.manage"]}
                    selected={["calendar.manage"]}
                    effective={new Set(["calendar.read", "calendar.manage"])}
                    onToggle={toggle}
                />,
                "es-ES"
            )
        );
        expect(html).toContain("Crear, cambiar y eliminar eventos");
        expect(html).toContain("Incluido con Crear, cambiar y eliminar eventos");
        expect(toggle).not.toHaveBeenCalled();
    });
});
