/**
 * One search across every app a connected assistant can reach: `polaris_search`.
 *
 * Polaris is one MCP server for many apps, and the list of tools grows with
 * every one installed. A model asked to "open the garage" should not have to
 * guess which of forty tools lists garages, or in which language the garage was
 * named. It asks this once, and gets typed references back - which app, what
 * kind of thing, its id and name, where it is, and the tools to call next with
 * the arguments to pass them.
 *
 * Each app answers through a search provider, registered the way its tools
 * are: core's in `tools/index.ts` (`MCP_SEARCH_PROVIDERS`), an installable
 * app's through the `mcpSearch` hook of its extension, built with
 * `host.mcp.defineSearch`. A provider:
 *
 * - names the scope it needs (`scope`), exactly as a tool does; a caller
 *   holding none of them is never asked, and it enforces everything finer
 *   itself, with the checks its own tools use (`placesReach`, the task
 *   layer's visible scope, a server's console grant);
 * - answers candidates rather than a verdict: everything the caller reaches
 *   that is cheap to list, or, for a store too large for that (mail), what its
 *   own search finds for the query. Ranking is done here, once, with the
 *   tolerant matcher (`@polaris/core` `rankEntities`), so every app's results
 *   are ordered by the same rule;
 * - is bounded: it is asked for at most `PROVIDER_LIMIT` hits and anything
 *   past that is dropped, and it has `PROVIDER_TIMEOUT_MS` to answer. One
 *   that throws or runs out of time is logged and left out - the answer says
 *   which apps it lacks - and never fails the search.
 *
 * Adding a provider, in an installable app:
 *
 *     mcpSearch: async () => [
 *         host.mcp.defineSearch({
 *             id: "databases.connections",
 *             app: "databases",
 *             category: "databases",
 *             scope: "databases.read",
 *             async search(_query, caller, limit) {
 *                 const rows = await reachableConnections(caller.userId, limit);
 *                 return rows.map((row) => ({
 *                     id: row.id,
 *                     name: row.name,
 *                     kind: "database",
 *                     where: row.server,
 *                     keywords: [row.engine],
 *                     next: [{ tool: "databases_query", args: { databaseId: row.id } }]
 *                 }));
 *             }
 *         })
 *     ]
 *
 * In core it is the same object, added to `MCP_SEARCH_PROVIDERS`.
 *
 * Server-only (the providers reach the database); this module itself only
 * runs them.
 */

import * as core from "@polaris/core";
import type { McpCategory, McpScope } from "./scope-table";
import { toolScopes, type McpCaller, type McpTool } from "./protocol";

/** A call a model can make next about a hit. */
export interface McpNextStep {
    /** The tool's name, as `tools/list` has it. */
    readonly tool: string;
    /** The arguments that pick this hit out; the rest are the model's. */
    readonly args?: Readonly<Record<string, unknown>>;
}

/** One thing a provider found. */
export interface McpSearchHit {
    readonly id: string;
    /** What it is called, as its app shows it. */
    readonly name: string;
    /** What it is, in a word or two ("device", "camera", "calendar event"). */
    readonly kind: string;
    /** Where it is: a place and room, a notebook, a storage. */
    readonly where?: string | null;
    /** Other words that find it and are not its name: a device's kind
     *  ("lock"), a server's game. Read by the ranking, not shown. */
    readonly keywords?: readonly (string | null | undefined)[];
    /** The tools that act on it, best first. */
    readonly next: readonly McpNextStep[];
}

/** An app's way into `polaris_search`. */
export interface McpSearchProvider {
    /** Unique across providers, `<app>.<what>`; names it in the log. */
    readonly id: string;
    /** The app its hits are from, as a model reads it ("places", "mail"). */
    readonly app: string;
    readonly category: McpCategory;
    /** The scope the caller must hold, or a list of which any one will do -
     *  the same rule as a tool's. */
    readonly scope: McpScope | readonly McpScope[];
    /** Candidates for the query, at most `limit` of them. */
    search(query: string, caller: McpCaller, limit: number): Promise<readonly McpSearchHit[]>;
}

/** Identity, for the type: what `host.mcp.defineSearch` is. */
export function defineMcpSearch(provider: McpSearchProvider): McpSearchProvider {
    return provider;
}

/**
 * At most `limit` of a provider's rows, the ones that match the query first.
 * For a provider that reads more rows than it may hand in: what it drops is
 * then what the query did not name, never an arbitrary tail.
 */
export function preferMatches<T>(
    rows: readonly T[],
    query: string,
    fields: readonly core.SearchField<T>[],
    limit: number
): T[] {
    if (rows.length <= limit) return [...rows];
    const ranked = core.rankEntities(rows, query, fields).map((entry) => entry.item);
    const picked = new Set(ranked);
    return [...ranked, ...rows.filter((row) => !picked.has(row))].slice(0, limit);
}

/** A hit as `polaris_search` hands it to the model. */
export interface McpSearchRef {
    readonly app: string;
    readonly kind: string;
    readonly id: string;
    readonly name: string;
    readonly where: string | null;
    readonly next: readonly McpNextStep[];
}

/** The most hits one provider may hand in. */
export const PROVIDER_LIMIT = 200;
/** How long one provider has to answer. */
export const PROVIDER_TIMEOUT_MS = 4_000;

interface Ranked {
    readonly ref: McpSearchRef;
    readonly keywords: readonly (string | null | undefined)[];
}

const REF_FIELDS: readonly core.SearchField<Ranked>[] = [
    { text: (row) => row.ref.name, weight: 1 },
    { text: (row) => [row.ref.kind, ...row.keywords], weight: 0.85 },
    { text: (row) => row.ref.where, weight: 0.6 },
    { text: (row) => row.ref.app, weight: 0.4 }
];

export interface SearchAnswer {
    readonly refs: McpSearchRef[];
    /** The sentence that goes above refs that are not a match. */
    readonly note: string | null;
    readonly matched: boolean;
    /** Providers that were asked and did not answer, by app. */
    readonly missing: string[];
}

class ProviderTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderTimeout()), ms);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Ask every provider the caller may use, in parallel, and rank what they
 * found. `tools` is the catalogue the caller sees: a next step naming a tool
 * that is not on it, or one the caller lacks the scope for, is left off - a
 * model is never pointed at a call it would be refused.
 */
export async function searchEverywhere(input: {
    readonly query: string;
    readonly caller: McpCaller;
    readonly providers: readonly McpSearchProvider[];
    readonly tools: readonly McpTool<never>[];
    readonly limit: number;
    readonly timeoutMs?: number;
}): Promise<SearchAnswer> {
    const { query, caller, limit } = input;
    const holds = (scopes: readonly McpScope[]) =>
        scopes.length === 0 || scopes.some((scope) => caller.scopes.includes(scope));
    const usable = new Set(
        input.tools.filter((tool) => holds(toolScopes(tool))).map((tool) => tool.name)
    );
    const asked = input.providers.filter((provider) => holds(toolScopes(provider)));
    const missing: string[] = [];

    const answers = await Promise.all(
        asked.map(async (provider) => {
            try {
                const hits = await withTimeout(
                    provider.search(query, caller, PROVIDER_LIMIT),
                    input.timeoutMs ?? PROVIDER_TIMEOUT_MS
                );
                return hits.slice(0, PROVIDER_LIMIT).map(
                    (hit): Ranked => ({
                        ref: {
                            app: provider.app,
                            kind: hit.kind,
                            id: hit.id,
                            name: hit.name,
                            where: hit.where ?? null,
                            next: hit.next.filter((step) => usable.has(step.tool))
                        },
                        keywords: hit.keywords ?? []
                    })
                );
            } catch (caught) {
                if (caught instanceof ProviderTimeout) {
                    console.warn(`mcp: search provider ${provider.id} did not answer in time`);
                } else {
                    console.error(`mcp: search provider ${provider.id} failed`, caught);
                }
                if (!missing.includes(provider.app)) missing.push(provider.app);
                return [];
            }
        })
    );

    const found = core.matchForModel(
        answers.flat(),
        query,
        REF_FIELDS,
        { one: "thing this connection can reach", other: "things this connection can reach" },
        limit
    );
    return {
        refs: found.items.map((row) => row.ref),
        note: found.note,
        matched: found.matched,
        missing
    };
}

/** One reference as a line a model reads. */
export function refLine(ref: McpSearchRef): string {
    const where = ref.where ? ` in ${ref.where}` : "";
    const next = ref.next.length
        ? ` -> ${ref.next
              .map((step) =>
                  step.args && Object.keys(step.args).length
                      ? `${step.tool} ${JSON.stringify(step.args)}`
                      : step.tool
              )
              .join(", ")}`
        : "";
    return `[${ref.app}/${ref.kind}] ${ref.name}${where} (id ${ref.id})${next}`;
}
