/**
 * Add connection groups every way in by who makes it, so connecting Anthropic
 * offers its key and the Claude subscription together, and xAI its key and the
 * SuperGrok sign-in.
 */

import { describe, expect, it } from "vitest";
import { groupConnections, matchesConnection } from "@/components/model-keys/add-connection";
import type { ConnectionOption } from "@/components/model-keys/connection-hub";
import type { ProviderRow } from "@/lib/agents/model-key-providers";

const row = (slug: string, name: string): ProviderRow =>
    ({ slug, name, aliases: [], apiKeyLabel: null, apiKeyHelp: null, createUrl: null, isGateway: false, checkable: true, freeTier: null }) as ProviderRow;

const options: ConnectionOption[] = [
    { method: "login", slug: "xai", name: "SuperGrok", vendor: "SuperGrok" },
    { method: "cloud", slug: "amazon-bedrock", name: "Amazon Bedrock", vendor: "Amazon Bedrock" },
    { method: "account", slug: "claude-token", name: "Claude subscription token", vendor: "Anthropic", aliases: ["Claude Code"] },
    { method: "home", slug: "cursor", name: "Cursor", vendor: "Anysphere" }
];

describe("Add connection", () => {
    const groups = groupConnections(options, [row("anthropic", "Anthropic"), row("xai", "xAI")]);
    const find = (name: string) => groups.find((group) => group.name === name);

    it("offers a provider's plan beside its key, plan first", () => {
        expect(find("xAI")?.ways.map((way) => way.option.method)).toEqual(["login", "key"]);
        expect(find("Anthropic")?.ways.map((way) => way.option.method)).toEqual(["account", "key"]);
    });

    it("keeps what no provider row matches as its own entry", () => {
        expect(find("Amazon Bedrock")?.ways.map((way) => way.option.method)).toEqual(["cloud"]);
        expect(find("Cursor")?.ways.map((way) => way.option.slug)).toEqual(["cursor"]);
    });

    it("puts one maker's ways together when no provider row is theirs", () => {
        const github = groupConnections(
            [
                { method: "account", slug: "copilot-plan", name: "GitHub Copilot plan", vendor: "GitHub" },
                { method: "account", slug: "github-token", name: "GitHub token", vendor: "GitHub" }
            ],
            []
        );
        expect(github).toHaveLength(1);
        expect(github[0]?.name).toBe("GitHub");
        expect(github[0]?.ways.map((way) => way.option.slug)).toEqual(["copilot-plan", "github-token"]);
    });

    it("hands a key the provider row it opens on", () => {
        expect(find("xAI")?.ways.find((way) => way.option.method === "key")?.row?.slug).toBe("xai");
    });

    it("finds a way by the tool's name as well as its own", () => {
        expect(matchesConnection(options[2]!, "claude code")).toBe(true);
        expect(matchesConnection(options[2]!, "gemini")).toBe(false);
    });

    it("carries a single-account sign-in's flag onto its way", () => {
        const single = groupConnections(
            [{ method: "home", slug: "mimo", name: "MiMo Code", vendor: "Xiaomi", single: true }],
            []
        );
        expect(single[0]?.ways[0]?.option.single).toBe(true);
        expect(find("Cursor")?.ways[0]?.option.single).toBeUndefined();
    });

    it("offers a folder-kept account beside the home login, neither marked single", () => {
        const kimi = groupConnections(
            [
                { method: "account", slug: "kimi-account", name: "Kimi Code account", vendor: "Moonshot AI", aliases: ["Kimi Code"] },
                { method: "home", slug: "kimi", name: "Kimi Code", vendor: "Moonshot AI" }
            ],
            []
        );
        const ways = kimi.flatMap((group) => group.ways);
        expect(ways.map((way) => way.option.method).sort()).toEqual(["account", "home"]);
        expect(ways.some((way) => way.option.single)).toBe(false);
    });
});
