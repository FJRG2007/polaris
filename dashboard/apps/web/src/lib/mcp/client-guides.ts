/**
 * The MCP clients Account > AI assistants has a guide for, and what each guide
 * shows: its numbered steps, the value beside a step that has one to copy, and
 * the install link where the client documents one.
 *
 * Pure data over `client-setup`, so the screen, the docs and the tests read one
 * list. A client is here only when its own documentation says how to add a
 * custom remote server; the link to that page is on every guide. The words of
 * each step are in the `mcpConnect` catalog under `clients.<id>.<step>`.
 */

import * as setup from "@/lib/mcp/client-setup";

/** The two addresses of this instance's MCP endpoint. */
export interface ServerUrls {
    /** Streamable HTTP, `/api/mcp`. */
    http: string;
    /** Legacy HTTP+SSE, `/api/mcp/sse`. */
    sse: string;
}

/** A mark the repo draws inline, or a file it serves under /logos. */
export type ClientLogo = { mark: "claude" | "openai" | "cursor" } | { src: string };

export type CopyKind = "url" | "command" | "config";

export interface GuideStep {
    /** The step's message, `clients.<id>.<key>`. */
    key: string;
    /** What to copy at this step, if anything. */
    copy?: { kind: CopyKind; value: (urls: ServerUrls) => string };
}

export interface ClientGuide {
    id: string;
    /** The product's own name, the same in every language. */
    name: string;
    logo: ClientLogo;
    steps: GuideStep[];
    /** Notes under the steps (plans, admin rules), `clients.<id>.<key>`. */
    notes?: string[];
    /** A one-click install the client documents. */
    install?: { key: string; href: (urls: ServerUrls) => string };
    /** The client's own settings page, opened in a new tab. */
    open?: { key: string; href: string };
    docs?: string;
    /** Words people search by besides the name. */
    aliases?: string[];
}

const url = { kind: "url", value: (urls: ServerUrls) => urls.http } as const;

export const CLIENT_GUIDES: readonly ClientGuide[] = [
    {
        id: "claude",
        name: "Claude",
        aliases: ["claude.ai", "claude desktop", "anthropic"],
        logo: { mark: "claude" },
        steps: [{ key: "step1" }, { key: "step2", copy: url }, { key: "step3" }],
        notes: ["teams"],
        open: { key: "open", href: setup.CLAUDE_CONNECTORS_URL },
        docs: setup.SETUP_GUIDES.claude
    },
    {
        id: "claudeCode",
        name: "Claude Code",
        aliases: ["anthropic", "cli"],
        logo: { mark: "claude" },
        steps: [
            {
                key: "step1",
                copy: { kind: "command", value: (urls) => setup.claudeCodeCommand(urls.http) }
            },
            { key: "step2" }
        ],
        docs: setup.SETUP_GUIDES.claudeCode
    },
    {
        id: "chatgpt",
        name: "ChatGPT",
        aliases: ["openai"],
        logo: { mark: "openai" },
        steps: [
            { key: "step1" },
            { key: "step2" },
            { key: "step3", copy: url },
            { key: "step4" },
            { key: "step5" },
            { key: "step6" }
        ],
        notes: ["missing", "plans"],
        docs: setup.SETUP_GUIDES.chatgpt
    },
    {
        id: "cursor",
        name: "Cursor",
        logo: { mark: "cursor" },
        install: { key: "install", href: (urls) => setup.cursorInstallLink(urls.http) },
        steps: [
            {
                key: "step1",
                copy: { kind: "config", value: (urls) => setup.cursorConfig(urls.http) }
            },
            { key: "step2" }
        ],
        docs: setup.SETUP_GUIDES.cursor
    },
    {
        id: "vscode",
        name: "Visual Studio Code",
        aliases: ["vs code", "copilot", "github"],
        logo: { src: "/logos/vscode.svg" },
        install: { key: "install", href: (urls) => setup.vscodeInstallLink(urls.http) },
        steps: [
            {
                key: "step1",
                copy: { kind: "config", value: (urls) => setup.vscodeConfig(urls.http) }
            },
            { key: "step2" }
        ],
        docs: setup.SETUP_GUIDES.vscode
    },
    {
        id: "copilot",
        name: "GitHub Copilot",
        aliases: ["github", "copilot cli"],
        logo: { src: "/logos/github-copilot.svg" },
        steps: [
            {
                key: "step1",
                copy: { kind: "command", value: (urls) => setup.copilotCliCommand(urls.http) }
            },
            { key: "step2" }
        ],
        notes: ["vscode", "cloudAgent"],
        docs: setup.SETUP_GUIDES.copilot
    },
    {
        id: "codex",
        name: "Codex CLI",
        aliases: ["openai"],
        logo: { mark: "openai" },
        steps: [
            {
                key: "step1",
                copy: { kind: "command", value: (urls) => setup.codexCommands(urls.http) }
            }
        ]
    },
    {
        id: "devin",
        name: "Devin",
        aliases: ["cognition"],
        logo: { src: "/logos/devin.svg" },
        steps: [{ key: "step1" }, { key: "step2", copy: url }, { key: "step3" }],
        docs: setup.SETUP_GUIDES.devin
    },
    {
        id: "figma",
        name: "Figma Make",
        aliases: ["figma"],
        logo: { src: "/logos/figma.svg" },
        steps: [{ key: "step1" }, { key: "step2", copy: url }, { key: "step3" }],
        notes: ["plans"],
        docs: setup.SETUP_GUIDES.figma
    },
    {
        id: "grok",
        name: "Grok",
        aliases: ["xai"],
        logo: { src: "/logos/grok.svg" },
        steps: [{ key: "step1" }, { key: "step2" }, { key: "step3", copy: url }],
        notes: ["business"],
        open: { key: "open", href: setup.GROK_CONNECTORS_URL },
        docs: setup.SETUP_GUIDES.grok
    },
    {
        id: "mistral",
        name: "Mistral Le Chat",
        aliases: ["mistral"],
        logo: { src: "/logos/mistral.svg" },
        steps: [{ key: "step1" }, { key: "step2", copy: url }, { key: "step3" }],
        notes: ["admin"],
        docs: setup.SETUP_GUIDES.mistral
    },
    {
        id: "zapier",
        name: "Zapier",
        logo: { src: "/logos/zapier.svg" },
        steps: [{ key: "step1" }, { key: "step2", copy: url }, { key: "step3" }],
        docs: setup.SETUP_GUIDES.zapier
    },
    {
        id: "make",
        name: "Make",
        aliases: ["integromat"],
        logo: { src: "/logos/make.svg" },
        steps: [{ key: "step1" }, { key: "step2", copy: url }, { key: "step3" }],
        docs: setup.SETUP_GUIDES.make
    },
    {
        id: "opencode",
        name: "OpenCode",
        logo: { src: "/logos/opencode.svg" },
        steps: [
            {
                key: "step1",
                copy: { kind: "config", value: (urls) => setup.opencodeConfig(urls.http) }
            },
            {
                key: "step2",
                copy: { kind: "command", value: () => setup.opencodeAuthCommand() }
            }
        ],
        docs: setup.SETUP_GUIDES.opencode
    },
    {
        id: "kimi",
        name: "Kimi Code",
        aliases: ["kimi cli", "moonshot"],
        logo: { src: "/logos/kimi.svg" },
        steps: [
            {
                key: "step1",
                copy: { kind: "command", value: (urls) => setup.kimiAddCommand(urls.http) }
            },
            {
                key: "step2",
                copy: { kind: "command", value: () => setup.kimiAuthCommand() }
            }
        ],
        docs: setup.SETUP_GUIDES.kimi
    }
];

/** The connection types the generic guide offers, most capable first. */
export const CONNECTION_TYPES = [
    { id: "http", value: (urls: ServerUrls) => setup.streamableHttpConfig(urls.http) },
    { id: "sse", value: (urls: ServerUrls) => setup.sseConfig(urls.sse) },
    { id: "stdio", value: (urls: ServerUrls) => setup.stdioConfig(urls.http) }
] as const;

export type ConnectionType = (typeof CONNECTION_TYPES)[number]["id"];

/** Clients whose name or alias contains the query, ignoring case and accents. */
export function matchClients(query: string, guides = CLIENT_GUIDES): readonly ClientGuide[] {
    const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const wanted = fold(query.trim());
    if (!wanted) return guides;
    return guides.filter((guide) =>
        [guide.name, ...(guide.aliases ?? [])].some((word) => fold(word).includes(wanted))
    );
}
