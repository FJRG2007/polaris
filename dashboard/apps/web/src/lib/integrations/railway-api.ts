/**
 * The Railway public API, as much of it as Polaris needs.
 *
 * One endpoint and one verb: everything Railway exposes is a GraphQL document
 * posted to the same address, which is why this is a query runner rather than a
 * list of paths. Polaris is a control plane here, not a second build farm - what
 * it reaches for is who the token speaks for, which projects it covers, and what
 * each service has deployed.
 *
 * The token matters more than it usually does. Railway has three kinds, and only
 * an account token can answer "who am I" at all: a workspace or project token is
 * scoped to the thing it was made for and refuses the question. That refusal is
 * passed through as their own words rather than dressed up, because it is the one
 * mistake somebody will actually make here.
 *
 * Server-only. The token never leaves it.
 */

import { z } from "zod";

const API = "https://backboard.railway.com/graphql/v2";

const TIMEOUT_MS = 15_000;

export class RailwayError extends Error {
    readonly kind: "unauthorized" | "refused" | "unreachable";

    constructor(message: string, kind: RailwayError["kind"]) {
        super(message);
        this.name = "RailwayError";
        this.kind = kind;
    }
}

const meSchema = z.object({
    id: z.string(),
    name: z.string().nullable().default(null),
    email: z.string().default("")
});

export type RailwayAccount = z.infer<typeof meSchema>;

const envelopeSchema = z.object({
    data: z.unknown().optional(),
    errors: z
        .array(z.object({ message: z.string().default("") }))
        .optional()
});

/**
 * One document, with the token on it.
 *
 * GraphQL answers 200 with an `errors` array for most of what other APIs answer
 * 4xx for, so the status alone says almost nothing: an unauthorized token comes
 * back as a perfectly successful HTTP response carrying "Not Authorized". Both
 * are read, and their own sentence is what reaches the screen.
 */
async function query(token: string, document: string, variables: Record<string, unknown> = {}): Promise<unknown> {
    let response: Response;
    try {
        response = await fetch(API, {
            method: "POST",
            cache: "no-store",
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "application/json"
            },
            body: JSON.stringify({ query: document, variables })
        });
    } catch {
        throw new RailwayError("Railway could not be reached. Try again in a moment.", "unreachable");
    }

    if (response.status === 401 || response.status === 403) {
        throw new RailwayError("Railway refused the token. It may have been revoked.", "unauthorized");
    }

    const text = await response.text().catch(() => "");
    let payload: unknown = null;
    if (text) {
        try {
            payload = JSON.parse(text) as unknown;
        } catch {
            payload = null;
        }
    }

    const parsed = envelopeSchema.safeParse(payload);
    if (!parsed.success) throw new RailwayError("Railway answered with something unexpected.", "refused");

    const complaint = parsed.data.errors?.[0]?.message?.trim();
    if (complaint) {
        // "Not Authorized" is what a workspace or project token gets for asking
        // about an account, and it is the mistake worth naming precisely.
        const unauthorized = /not authori[sz]ed|unauthorized/i.test(complaint);
        throw new RailwayError(
            unauthorized
                ? "Railway did not accept that token for this. An account token reaches every workspace you are in; a workspace or project token cannot answer for the account."
                : complaint,
            unauthorized ? "unauthorized" : "refused"
        );
    }
    if (!response.ok) {
        throw new RailwayError(`Railway refused the request (HTTP ${response.status}).`, "refused");
    }
    return parsed.data.data;
}

/**
 * Who the token speaks for.
 *
 * The check as well as the answer, the same way the other providers here are
 * checked: the account a link shows is the one Railway says the token belongs to,
 * rather than a name somebody typed.
 */
export async function railwayAccount(token: string): Promise<RailwayAccount> {
    const parsed = z
        .object({ me: meSchema })
        .safeParse(await query(token, "query { me { id name email } }"));
    if (!parsed.success) throw new RailwayError("Railway answered with something unexpected.", "refused");
    return parsed.data.me;
}

const nodesOf = <T extends z.ZodTypeAny>(node: T) =>
    z.object({ edges: z.array(z.object({ node })).default([]) }).default({ edges: [] });

const namedSchema = z.object({ id: z.string(), name: z.string().default("") });

export type RailwayNamed = z.infer<typeof namedSchema>;

/** Every project this token reaches. An account token sees every workspace its
 *  owner is in; a project token sees the one it was made for. */
export async function railwayProjects(token: string): Promise<RailwayNamed[]> {
    const parsed = z
        .object({ projects: nodesOf(namedSchema) })
        .safeParse(await query(token, "query { projects { edges { node { id name } } } }"));
    if (!parsed.success) throw new RailwayError("Railway answered with something unexpected.", "refused");
    return parsed.data.projects.edges.map((edge) => edge.node);
}

const projectSchema = namedSchema.extend({
    services: nodesOf(namedSchema),
    environments: nodesOf(namedSchema)
});

export interface RailwayProject {
    readonly id: string;
    readonly name: string;
    readonly services: readonly RailwayNamed[];
    readonly environments: readonly RailwayNamed[];
}

/**
 * One project, with what is inside it.
 *
 * Both lists are needed to point at anything: a deployment on Railway belongs to
 * a service AND an environment, and neither of those is implied by the project.
 */
export async function railwayProject(token: string, id: string): Promise<RailwayProject> {
    const parsed = z.object({ project: projectSchema }).safeParse(
        await query(
            token,
            `query project($id: String!) {
                project(id: $id) {
                    id
                    name
                    services { edges { node { id name } } }
                    environments { edges { node { id name } } }
                }
            }`,
            { id }
        )
    );
    if (!parsed.success) throw new RailwayError("Railway answered with something unexpected.", "refused");
    const project = parsed.data.project;
    return {
        id: project.id,
        name: project.name,
        services: project.services.edges.map((edge) => edge.node),
        environments: project.environments.edges.map((edge) => edge.node)
    };
}

const railwayDeploymentSchema = z.object({
    id: z.string(),
    /** BUILDING | DEPLOYING | SUCCESS | FAILED | CRASHED | REMOVED | ... */
    status: z.string().default(""),
    createdAt: z.string().default(""),
    staticUrl: z.string().nullable().default(null)
});

export type RailwayDeployment = z.infer<typeof railwayDeploymentSchema>;

/** The most recent deployments of one service in one environment, newest first. */
export async function railwayDeployments(
    token: string,
    input: { project: string; service: string; environment: string; limit?: number }
): Promise<RailwayDeployment[]> {
    const parsed = z.object({ deployments: nodesOf(railwayDeploymentSchema) }).safeParse(
        await query(
            token,
            `query deployments($input: DeploymentListInput!, $first: Int!) {
                deployments(input: $input, first: $first) {
                    edges { node { id status createdAt staticUrl } }
                }
            }`,
            {
                input: {
                    projectId: input.project,
                    serviceId: input.service,
                    environmentId: input.environment
                },
                first: Math.max(1, Math.min(20, input.limit ?? 5))
            }
        )
    );
    if (!parsed.success) throw new RailwayError("Railway answered with something unexpected.", "refused");
    return parsed.data.deployments.edges.map((edge) => edge.node);
}

/**
 * The variables one service runs with.
 *
 * Their `variables` query answers with a plain object of name to value rather
 * than a list of rows, which is why nothing here has a schema of its own: what
 * comes back is checked to be an object of strings and taken as it is.
 *
 * Only what is worth carrying somewhere else. Railway's own - the ones it sets
 * for a service, and the `${{...}}` references that only mean something inside
 * their project - are left where they are: a reference copied out of Railway is
 * a literal string of punctuation anywhere else.
 */
export async function railwayVariables(
    token: string,
    input: { project: string; service: string; environment: string }
): Promise<Record<string, string>> {
    const answer = await query(
        token,
        `query variables($projectId: String!, $environmentId: String!, $serviceId: String!) {
            variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
        }`,
        {
            projectId: input.project,
            environmentId: input.environment,
            serviceId: input.service
        }
    );
    const parsed = z
        .object({ variables: z.record(z.string(), z.string()).default({}) })
        .safeParse(answer);
    if (!parsed.success) throw new RailwayError("Railway answered with something unexpected.", "refused");

    const found: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.data.variables)) {
        if (key.startsWith("RAILWAY_")) continue;
        if (value.includes("${{")) continue;
        found[key] = value;
    }
    return found;
}

/**
 * Put variables on one service, replacing any of the same name.
 *
 * Never `replace`, which would delete everything not named here: this is asked
 * for by a move that brings a set of variables from somewhere else, and a move
 * that also quietly removed whatever Railway had would be a move nobody could
 * undo.
 *
 * A deploy is skipped, because the caller does that itself once everything is in
 * place - otherwise a service with thirty variables would build thirty times.
 */
export async function railwaySetVariables(
    token: string,
    input: {
        project: string;
        service: string;
        environment: string;
        variables: Readonly<Record<string, string>>;
    }
): Promise<void> {
    if (Object.keys(input.variables).length === 0) return;
    await query(
        token,
        `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
            variableCollectionUpsert(input: $input)
        }`,
        {
            input: {
                projectId: input.project,
                environmentId: input.environment,
                serviceId: input.service,
                variables: input.variables,
                replace: false,
                skipDeploys: true
            }
        }
    );
}

/**
 * Build and release one service again.
 *
 * Their own words for it: a service instance in an environment is deployed. What
 * goes into the build is Railway's to decide - which is the whole point of a
 * service running there - so nothing is sent but which one to repeat.
 */
export async function railwayDeploy(
    token: string,
    input: { service: string; environment: string }
): Promise<void> {
    await query(
        token,
        `mutation serviceInstanceDeploy($serviceId: String!, $environmentId: String!) {
            serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId)
        }`,
        { serviceId: input.service, environmentId: input.environment }
    );
}
