/**
 * How the API reference is cut into pages: an overview, a page per group and a
 * page per call, in reading order. Pure, so the addresses, the order and the
 * responses every call shares can be asserted without building the site.
 */

import type { ApiOperation } from "@/data/builders";

export interface ApiGroup {
    readonly tag: string;
    readonly operations: readonly ApiOperation[];
}

export interface ApiResponse {
    readonly status: string;
    readonly description: string;
}

/** The page listing routes that answer to a key but are not documented yet. */
export const API_MORE_SLUG = "more";

/** A group's address segment: `Deploy` -> `deploy`. */
export function groupSlug(tag: string): string {
    return (
        tag
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "other"
    );
}

/** A call's address segment, from its operation id: `getDeployServicesById` -> `get-deploy-services-by-id`. */
export function operationSlug(op: Pick<ApiOperation, "id">): string {
    return (
        op.id
            .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "operation"
    );
}

/** The page paths, relative to the locale root, with the trailing slash the export uses. */
export const apiPath = {
    overview: () => "docs/api/",
    group: (tag: string) => `docs/api/${groupSlug(tag)}/`,
    operation: (op: Pick<ApiOperation, "id" | "tag">) =>
        `docs/api/${groupSlug(op.tag)}/${operationSlug(op)}/`,
    more: () => `docs/api/${API_MORE_SLUG}/`
};

export type ApiPage =
    | { kind: "overview"; path: string }
    | { kind: "group"; path: string; group: ApiGroup }
    | { kind: "operation"; path: string; group: ApiGroup; operation: ApiOperation }
    | { kind: "more"; path: string };

/** Every page of the reference in reading order: overview, then each group followed by its calls. */
export function apiPages(groups: readonly ApiGroup[], undocumented: number): ApiPage[] {
    const pages: ApiPage[] = [{ kind: "overview", path: apiPath.overview() }];
    for (const group of groups) {
        pages.push({ kind: "group", path: apiPath.group(group.tag), group });
        for (const operation of group.operations)
            pages.push({
                kind: "operation",
                path: apiPath.operation(operation),
                group,
                operation
            });
    }
    if (undocumented) pages.push({ kind: "more", path: apiPath.more() });
    return pages;
}

/** The pages before and after one, by path. */
export function apiNeighbors(
    pages: readonly ApiPage[],
    path: string
): { previous: ApiPage | null; next: ApiPage | null } {
    const at = pages.findIndex((page) => page.path === path);
    if (at < 0) return { previous: null, next: null };
    return { previous: pages[at - 1] ?? null, next: pages[at + 1] ?? null };
}

/**
 * The responses most calls share - a bad request, a missing key, a refused
 * permission - documented once on the overview instead of under every call.
 * A status counts when at least half the calls answer it with the same words.
 */
export function commonResponses(operations: readonly ApiOperation[]): ApiResponse[] {
    const counts = new Map<string, { response: ApiResponse; count: number }>();
    for (const op of operations)
        for (const response of op.responses) {
            if (!/^[45]/.test(response.status)) continue;
            const key = `${response.status}\n${response.description}`;
            const seen = counts.get(key);
            if (seen) seen.count++;
            else counts.set(key, { response, count: 1 });
        }
    const common = new Map<string, ApiResponse>();
    for (const { response, count } of counts.values())
        if (count * 2 >= operations.length && !common.has(response.status))
            common.set(response.status, response);
    return [...common.values()].sort((a, b) => a.status.localeCompare(b.status));
}

const sameResponse = (a: ApiResponse, b: ApiResponse) =>
    a.status === b.status && a.description === b.description;

/** What a call answers beyond the shared responses, and which shared ones it can also give. */
export function splitResponses(
    op: Pick<ApiOperation, "responses">,
    common: readonly ApiResponse[]
): { own: ApiResponse[]; shared: ApiResponse[] } {
    return {
        own: op.responses.filter((response) => !common.some((one) => sameResponse(one, response))),
        shared: common.filter((one) => op.responses.some((response) => sameResponse(one, response)))
    };
}
