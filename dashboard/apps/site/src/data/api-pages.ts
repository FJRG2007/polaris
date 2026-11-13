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
/** Where a page's Markdown is served: the page's path without its slash, as `.md`. */
export function markdownPath(pagePath: string): string {
    return `${pagePath.replace(/\/+$/, "")}.md`;
}

/** The words an API page's Markdown is written with, from the site's catalog. */
export interface ApiMarkdownWords {
    readonly title: string;
    readonly intro: string;
    readonly baseTitle: string;
    readonly baseHint: string;
    readonly authTitle: string;
    readonly auth: string;
    readonly errorsTitle: string;
    readonly errorsIntro: string;
    readonly errorBody: string;
    readonly status: string;
    readonly meaning: string;
    readonly groupsTitle: string;
    readonly groupIntro: string;
    readonly params: string;
    readonly body: string;
    readonly examples: string;
    readonly responses: string;
    readonly required: string;
    readonly field: string;
    readonly type: string;
    readonly description: string;
    readonly location: string;
    readonly rawSchema: string;
    readonly shape: string;
    readonly sharedErrors: string;
    readonly noOwnResponses: string;
    readonly authNeeded: string;
    readonly undocumented: string;
    readonly undocumentedHint: string;
    readonly constraints: Readonly<Record<string, string>>;
}

export interface ApiMarkdownInput {
    readonly groups: readonly ApiGroup[];
    readonly undocumented: readonly { readonly method: string; readonly path: string }[];
    readonly words: ApiMarkdownWords;
    /** The placeholder Polaris the examples call. */
    readonly origin: string;
    /** The same call in curl, JavaScript and Python. */
    readonly samples: (
        op: Pick<ApiOperation, "method" | "path" | "body">
    ) => readonly { readonly label: string; readonly lang: string; readonly code: string }[];
    /** A page's absolute address, for the links between pages. */
    readonly link: (pagePath: string) => string;
}

/** A table cell: one line, its pipes escaped. */
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
    return [
        `| ${head.map(cell).join(" | ")} |`,
        `| ${head.map(() => "---").join(" | ")} |`,
        ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)
    ].join("\n");
}

const TICKS = "`".repeat(3);
const code = (text: string) => `${"`"}${text}${"`"}`;

function fence(text: string, lang: string): string {
    const ticks = text.includes(TICKS) ? `${TICKS}${"`"}` : TICKS;
    return `${ticks}${lang}\n${text}\n${ticks}`;
}

/**
 * An API page as Markdown, the text "Copy page" copies and an assistant reads:
 * the same sections the page shows, with the examples in full.
 */
export function apiMarkdown(page: ApiPage, input: ApiMarkdownInput): string {
    const t = input.words;
    const operations = input.groups.flatMap((group) => group.operations);
    const common = commonResponses(operations);
    const rules = (list: readonly { kind: string; value: string }[]) =>
        list.map((one) => `${t.constraints[one.kind] ?? one.kind}: ${code(one.value)}`).join(", ");
    const named = (name: string, required: boolean) =>
        `${code(name)}${required ? ` (${t.required})` : ""}`;
    const lines: string[] = [];
    switch (page.kind) {
        case "overview": {
            lines.push(`# ${t.title}`, "", t.intro, "");
            lines.push(`## ${t.baseTitle}`, "", t.baseHint, "");
            lines.push(fence(`${input.origin}/api/v1`, "text"), "");
            const auth = input.samples({ method: "GET", path: "/api/v1/me", body: null })[0];
            lines.push(`## ${t.authTitle}`, "", t.auth, "");
            if (auth) lines.push(fence(auth.code, auth.lang), "");
            lines.push(`## ${t.errorsTitle}`, "", t.errorsIntro, "");
            lines.push(
                table(
                    [t.status, t.meaning],
                    common.map((one) => [one.status, one.description])
                ),
                ""
            );
            lines.push(`${t.errorBody}:`, "", fence('{\n  "error": "string"\n}', "json"), "");
            lines.push(`## ${t.groupsTitle}`, "");
            for (const group of input.groups) {
                lines.push(`- [${group.tag}](${input.link(apiPath.group(group.tag))})`);
                for (const op of group.operations)
                    lines.push(
                        `  - [${code(`${op.method} ${op.path}`)}](${input.link(apiPath.operation(op))})${op.summary ? `: ${op.summary}` : ""}`
                    );
            }
            break;
        }
        case "group": {
            const { group } = page;
            lines.push(`# ${group.tag}`, "", t.groupIntro.replace("{group}", group.tag), "");
            for (const op of group.operations) {
                lines.push(`## [${op.summary || op.path}](${input.link(apiPath.operation(op))})`, "");
                lines.push(code(`${op.method} ${op.path}`), "");
                if (op.description) lines.push(op.description, "");
            }
            break;
        }
        case "operation": {
            const op = page.operation;
            lines.push(`# ${op.summary || op.path}`, "", code(`${op.method} ${op.path}`), "");
            if (op.description) lines.push(op.description, "");
            lines.push(`${t.authNeeded} (${input.link(apiPath.overview())}#authentication)`, "");
            if (op.parameters.length)
                lines.push(
                    `## ${t.params}`,
                    "",
                    table(
                        [t.field, t.location, t.type, t.description],
                        op.parameters.map((param) => [
                            named(param.name, param.required),
                            param.in,
                            code(param.type),
                            [param.description, rules(param.constraints)].filter(Boolean).join(" ")
                        ])
                    ),
                    ""
                );
            if (op.body) {
                lines.push(`## ${t.body}`, "");
                op.bodyShapes.forEach((shape, at) => {
                    if (op.bodyShapes.length > 1)
                        lines.push(
                            t.shape.replace("{n}", String(at + 1)).replace("{type}", shape.type),
                            ""
                        );
                    if (shape.fields.length)
                        lines.push(
                            table(
                                [t.field, t.type, t.description],
                                shape.fields.map((field) => [
                                    named(field.name, field.required),
                                    code(field.type),
                                    [field.description, rules(field.constraints)]
                                        .filter(Boolean)
                                        .join(" ")
                                ])
                            ),
                            ""
                        );
                });
                lines.push(`${t.rawSchema}:`, "", fence(op.body, "json"), "");
            }
            lines.push(`## ${t.examples}`, "");
            for (const sample of input.samples(op))
                lines.push(`${sample.label}:`, "", fence(sample.code, sample.lang), "");
            const { own, shared } = splitResponses(op, common);
            lines.push(`## ${t.responses}`, "");
            lines.push(
                own.length
                    ? table(
                          [t.status, t.meaning],
                          own.map((one) => [one.status, one.description])
                      )
                    : t.noOwnResponses,
                ""
            );
            if (shared.length)
                lines.push(
                    `${t.sharedErrors.replace("{statuses}", shared.map((one) => one.status).join(", "))} (${input.link(apiPath.overview())}#errors)`,
                    ""
                );
            break;
        }
        case "more": {
            lines.push(`# ${t.undocumented}`, "", t.undocumentedHint, "");
            for (const route of input.undocumented)
                lines.push(`- ${code(`${route.method} ${route.path}`)}`);
            break;
        }
    }
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
