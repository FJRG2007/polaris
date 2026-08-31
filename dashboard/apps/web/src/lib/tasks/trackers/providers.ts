/**
 * Talking to Linear and Jira.
 *
 * One interface, two very different APIs behind it. Everything above this file
 * works in `TrackerIssue` and never learns that Linear is GraphQL and Jira is
 * REST, which is what keeps the sync, the screens and the push identical for
 * both - and what makes adding a third tracker a file rather than a sweep.
 *
 * The credential belongs to a person, not to Polaris. Both providers authenticate
 * as the account whose key it is, so everything here happens as the operator who
 * connected it: an issue their account cannot see is one Polaris cannot see
 * either, and a status they cannot set is one this cannot set. That is the
 * correct shape for an integration into somebody else's system, and it is why
 * there is no shared application credential anywhere in here.
 */

import * as core from "@polaris/core";

/** How long any single call is given. Long enough for a slow search on a big
 *  Jira, short enough that a sync cannot hang a request forever. */
const TIMEOUT_MS = 20_000;

/** How many issues one request asks for. */
const PAGE = 100;

/** How many of those one pass will make. Paged rather than one request, because
 *  a connection with more issues than a page never sees the rest of them - both
 *  providers answer a page-sized ask with the same page every time. Bounded,
 *  because a tracker with fifty thousand issues in it is not a board anybody
 *  meant to mirror, and both providers answer newest-first so the pass that stops
 *  at the bound stops on the oldest. */
const MAX_PAGES = 10;

export interface TrackerCredential {
    readonly provider: core.IssueTracker;
    /** The non-secret half: a Jira site and account email. Empty for Linear. */
    readonly config: Record<string, string>;
    readonly secret: string;
    /** The provider's own query: a Linear team key, or a JQL string. */
    readonly query: string;
}

/** What a provider can be asked to do. Deliberately small - these four are what
 *  a two-way link between a board and a tracker actually needs. */
export interface TrackerClient {
    /** Whether the credential works, in a sentence, without changing anything. */
    check(): Promise<{ ok: boolean; detail: string }>;
    issues(): Promise<core.TrackerIssue[]>;
    /** Move an issue to the state that reads as `statusName`, or say why not. */
    setStatus(issue: { id: string; key: string }, statusName: string): Promise<void>;
    comment(issue: { id: string; key: string }, body: string): Promise<void>;
}

export function trackerClient(credential: TrackerCredential): TrackerClient {
    return credential.provider === "linear" ? linearClient(credential) : jiraClient(credential);
}

/** A failure with a sentence somebody can act on. Anything a provider says about
 *  its own refusal is more useful than a status code, so it is carried through. */
class TrackerError extends Error {}

async function call(url: string, init: RequestInit): Promise<Response> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.ok) return response;
    const said = (await response.text().catch(() => "")).slice(0, 400);
    throw new TrackerError(
        `${response.status} from ${new URL(url).host}${said ? `: ${said}` : ""}`
    );
}

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

const LINEAR_API = "https://api.linear.app/graphql";

/** The fields an issue is read with. One place, so a query and its parser cannot
 *  drift apart. */
const LINEAR_ISSUE_FIELDS = `
    id
    identifier
    title
    description
    url
    updatedAt
    state { name type }
    assignee { name }
`;

function linearClient(credential: TrackerCredential): TrackerClient {
    // Linear's personal API keys are sent bare rather than as a bearer token;
    // an OAuth access token is sent as one. Told apart by shape, because asking
    // the operator which kind they pasted is a question with a wrong answer.
    const authorization = credential.secret.startsWith("lin_oauth_")
        ? `Bearer ${credential.secret}`
        : credential.secret;

    const graphql = async (
        query: string,
        variables: Record<string, unknown> = {}
    ): Promise<unknown> => {
        const response = await call(LINEAR_API, {
            method: "POST",
            headers: { Authorization: authorization, "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables })
        });
        const payload = (await response.json()) as {
            data?: unknown;
            errors?: { message?: string }[];
        };
        if (payload.errors?.length) {
            throw new TrackerError(payload.errors[0]?.message ?? "Linear refused the request");
        }
        return payload.data;
    };

    // An empty query means every issue the key can see. A team key narrows it,
    // which is what almost everybody wants and what the field asks for.
    const filter = credential.query.trim()
        ? { team: { key: { eq: credential.query.trim() } } }
        : undefined;

    return {
        async check() {
            try {
                const data = (await graphql("query { viewer { name } }")) as {
                    viewer?: { name?: string };
                };
                return {
                    ok: true,
                    detail: `Connected as ${data.viewer?.name ?? "your Linear account"}.`
                };
            } catch (error) {
                return {
                    ok: false,
                    detail: error instanceof Error ? error.message : "Linear did not answer."
                };
            }
        },

        async issues() {
            const found: core.TrackerIssue[] = [];
            let after: string | null = null;
            for (let page = 0; page < MAX_PAGES; page += 1) {
                const data = (await graphql(
                    `query($first: Int!, $after: String, $filter: IssueFilter) {
                        issues(first: $first, after: $after, filter: $filter) {
                            nodes { ${LINEAR_ISSUE_FIELDS} }
                            pageInfo { hasNextPage endCursor }
                        }
                    }`,
                    { first: PAGE, after, filter }
                )) as {
                    issues?: {
                        nodes?: unknown[];
                        pageInfo?: { hasNextPage?: boolean; endCursor?: string };
                    };
                };
                for (const node of data.issues?.nodes ?? []) {
                    const issue = readLinearIssue(node);
                    if (issue) found.push(issue);
                }
                const info = data.issues?.pageInfo;
                if (!info?.hasNextPage || !info.endCursor) break;
                after = info.endCursor;
            }
            return found;
        },

        async setStatus(issue, statusName) {
            const data = (await graphql(
                `
                    query ($filter: WorkflowStateFilter) {
                        workflowStates(first: 100, filter: $filter) {
                            nodes {
                                id
                                name
                                type
                            }
                        }
                    }
                `,
                { filter: filter ? { team: { key: { eq: credential.query.trim() } } } : undefined }
            )) as { workflowStates?: { nodes?: { id: string; name: string }[] } };

            const states = data.workflowStates?.nodes ?? [];
            const wanted = flat(statusName);
            const state = states.find((candidate) => flat(candidate.name) === wanted);
            if (!state) {
                throw new TrackerError(
                    `Linear has no state called "${statusName}". It has: ${states
                        .map((candidate) => candidate.name)
                        .join(", ")}.`
                );
            }
            await graphql(
                "mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }",
                { id: issue.id, stateId: state.id }
            );
        },

        async comment(issue, body) {
            await graphql(
                "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
                { issueId: issue.id, body }
            );
        }
    };
}

function readLinearIssue(node: unknown): core.TrackerIssue | null {
    if (!node || typeof node !== "object") return null;
    const record = node as Record<string, unknown>;
    const state = (record.state ?? {}) as Record<string, unknown>;
    const assignee = (record.assignee ?? {}) as Record<string, unknown>;
    const key = str(record.identifier);
    if (!key) return null;
    const statusName = str(state.name);
    return {
        id: str(record.id),
        key,
        title: str(record.title),
        description: str(record.description),
        url: str(record.url),
        status: statusName,
        statusType: core.statusTypeFromTracker("linear", str(state.type), statusName),
        assignee: str(assignee.name),
        updatedAt: str(record.updatedAt)
    };
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

function jiraClient(credential: TrackerCredential): TrackerClient {
    const site = core.normalizeTrackerSite(credential.config.site ?? "");
    const email = (credential.config.email ?? "").trim();
    if (!site) throw new TrackerError("This Jira connection has no site on it.");
    // Checked here as well as at the form, because a row written by an older
    // build was never asked. Everything below interpolates this into a URL the
    // server itself calls, so an address that is not a Jira site is not one this
    // will connect to.
    if (!core.isTrackerSite(site)) {
        throw new TrackerError(
            `"${site}" is not a Jira address. It should look like your-company.atlassian.net.`
        );
    }

    const base = `https://${site}/rest/api/3`;
    const authorization = `Basic ${Buffer.from(`${email}:${credential.secret}`).toString("base64")}`;
    const headers = { Authorization: authorization, Accept: "application/json" };

    const get = async (path: string): Promise<unknown> =>
        (await call(`${base}${path}`, { headers })).json();

    const post = async (path: string, body: unknown): Promise<void> => {
        await call(`${base}${path}`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
    };

    const jql = credential.query.trim() || "order by updated DESC";
    const fields = "summary,description,status,assignee,updated";

    return {
        async check() {
            try {
                const data = (await get("/myself")) as { displayName?: string };
                return { ok: true, detail: `Connected as ${data.displayName ?? email}.` };
            } catch (error) {
                return {
                    ok: false,
                    detail: error instanceof Error ? error.message : "Jira did not answer."
                };
            }
        },

        async issues() {
            const search = `?jql=${encodeURIComponent(jql)}&maxResults=${PAGE}&fields=${fields}`;
            const found: core.TrackerIssue[] = [];
            // Jira replaced its search endpoint and kept the old one working for a
            // while. Both are tried rather than picking one, because which of them
            // a site answers on depends on the site: Cloud has moved, and a
            // self-hosted Data Center has not. They page differently too - a token
            // on the new one, an offset on the old - so which answered is
            // remembered rather than asked again for every page.
            let legacy = false;
            let token = "";
            let startAt = 0;
            for (let page = 0; page < MAX_PAGES; page += 1) {
                let data: unknown;
                if (!legacy) {
                    try {
                        const next = token ? `&nextPageToken=${encodeURIComponent(token)}` : "";
                        data = await get(`/search/jql${search}${next}`);
                    } catch (error) {
                        // Only the first page may fall back. Later on, a failure is
                        // the site refusing a page rather than the endpoint being
                        // the wrong one, and starting the walk again would mirror
                        // the same issues twice.
                        if (page > 0) throw error;
                        legacy = true;
                    }
                }
                if (legacy) data = await get(`/search${search}&startAt=${startAt}`);

                const batch = (data as { issues?: unknown[] }).issues ?? [];
                for (const node of batch) {
                    const issue = readJiraIssue(node, site);
                    if (issue) found.push(issue);
                }
                if (batch.length < PAGE) break;
                if (legacy) {
                    startAt += batch.length;
                    continue;
                }
                token = str((data as { nextPageToken?: unknown }).nextPageToken);
                if (!token) break;
            }
            return found;
        },

        async setStatus(issue, statusName) {
            const data = (await get(`/issue/${encodeURIComponent(issue.key)}/transitions`)) as {
                transitions?: { id: string; name: string; to?: { name?: string } }[];
            };
            const transitions = data.transitions ?? [];
            const wanted = flat(statusName);
            // Jira does not set a status; it applies a transition, and the two are
            // named differently often enough that both are matched. The state it
            // LEADS TO is the better match and is tried first.
            const transition =
                transitions.find((candidate) => flat(candidate.to?.name ?? "") === wanted) ??
                transitions.find((candidate) => flat(candidate.name) === wanted);
            if (!transition) {
                throw new TrackerError(
                    `${issue.key} has no transition to "${statusName}" from where it is. It offers: ${transitions
                        .map((candidate) => candidate.to?.name ?? candidate.name)
                        .join(", ")}.`
                );
            }
            await post(`/issue/${encodeURIComponent(issue.key)}/transitions`, {
                transition: { id: transition.id }
            });
        },

        async comment(issue, body) {
            await post(`/issue/${encodeURIComponent(issue.key)}/comment`, {
                // Jira's current API takes a document rather than text. One
                // paragraph is enough for what Polaris has to say and avoids
                // pretending to convert Markdown it did not produce.
                body: {
                    type: "doc",
                    version: 1,
                    content: [{ type: "paragraph", content: [{ type: "text", text: body }] }]
                }
            });
        }
    };
}

function readJiraIssue(node: unknown, site: string): core.TrackerIssue | null {
    if (!node || typeof node !== "object") return null;
    const record = node as Record<string, unknown>;
    const key = str(record.key);
    if (!key) return null;
    const fields = (record.fields ?? {}) as Record<string, unknown>;
    const status = (fields.status ?? {}) as Record<string, unknown>;
    const category = (status.statusCategory ?? {}) as Record<string, unknown>;
    const assignee = (fields.assignee ?? {}) as Record<string, unknown>;
    const statusName = str(status.name);
    return {
        id: str(record.id) || key,
        key,
        title: str(fields.summary),
        description: core.flattenRichText(fields.description).trim(),
        url: `https://${site}/browse/${key}`,
        status: statusName,
        statusType: core.statusTypeFromTracker("jira", str(category.key), statusName),
        assignee: str(assignee.displayName),
        updatedAt: str(fields.updated)
    };
}

// ---------------------------------------------------------------------------

function str(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** Names are compared with the punctuation and the case taken out: "In Progress",
 *  "in progress" and "In-Progress" are one status somebody spelled three ways. */
function flat(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
