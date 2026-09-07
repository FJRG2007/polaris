/**
 * The parts of AWS Polaris needs, and not one call more.
 *
 * Two services, because they are the two ways somebody runs a web application on
 * AWS and hands the building to AWS: **ECS** (which is what Fargate is - a launch
 * type, not a separate API) and **Amplify**. Both are reached with the same
 * signature and the same failure handling, so they share a file.
 *
 * No SDK. The official one is a package per service, each carrying a generated
 * model of every operation that service has; Polaris calls eight of them. What is
 * actually needed is the signature, which is eighty lines next door in
 * `aws-sign`, and the shapes below - which are checked against a schema on the way
 * in, because this is somebody else's server and a response that changed has to
 * fail here, saying so, rather than three layers further in as an undefined.
 *
 * The two protocols are AWS's, not a choice:
 *
 * - **ECS** speaks the JSON protocol: everything is `POST /`, the operation is a
 *   header, and the body is JSON.
 * - **Amplify** is an ordinary REST API, with the resource in the path.
 *
 * App Runner is deliberately absent. AWS closed it to new customers on
 * 31 March 2026, so building a way in for people who cannot sign up for it would
 * be building for nobody; an existing App Runner service is still reachable
 * through its own console.
 *
 * Server-only. Every call here is signed with somebody's secret key.
 */

import { z } from "zod";
import { awsHost, signAwsRequest, type AwsCredentials } from "@/lib/integrations/aws-sign";

/** Long enough for a listing on a slow morning, short enough that a screen
 *  waiting on it is not left there. */
const TIMEOUT_MS = 15_000;

/**
 * What went wrong, and whether the credentials are the problem.
 *
 * The distinction is the reason this is not a plain Error: a key that has been
 * deleted or disabled has to mark the link and say so, and a listing that timed
 * out has to leave everything where it was.
 */
export class AwsError extends Error {
    readonly kind: "unauthorized" | "refused" | "unreachable";

    constructor(message: string, kind: AwsError["kind"]) {
        super(message);
        this.name = "AwsError";
        this.kind = kind;
    }
}

/**
 * One signed call, with their answer read.
 *
 * Their error bodies are `{"__type": "...", "message": "..."}` for the JSON
 * services and `{"message": "..."}` for the REST ones, and the sentence in them
 * is worth showing: "The security token included in the request is invalid" is
 * what somebody has to act on, and a sentence Polaris invented instead is not.
 */
async function call(input: {
    credentials: AwsCredentials;
    service: string;
    method?: string;
    path?: string;
    query?: string;
    body?: unknown;
    target?: string;
    contentType?: string;
    /** A service that does not live in the account's own region. */
    host?: string;
}): Promise<unknown> {
    const body =
        input.body === undefined
            ? input.method === "GET"
                ? ""
                : "{}"
            : typeof input.body === "string"
              ? input.body
              : JSON.stringify(input.body);
    const signed = signAwsRequest({
        credentials: input.credentials,
        service: input.service,
        host: input.host ?? awsHost(input.service, input.credentials.region),
        method: input.method ?? "POST",
        path: input.path ?? "/",
        query: input.query ?? "",
        body,
        target: input.target,
        contentType: input.contentType ?? "application/x-amz-json-1.1"
    });

    let response: Response;
    try {
        response = await fetch(signed.url, {
            method: input.method ?? "POST",
            headers: signed.headers as Record<string, string>,
            // A GET with an empty string body is not a GET at all in some runtimes.
            ...(signed.body ? { body: signed.body } : {}),
            cache: "no-store",
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch {
        throw new AwsError("AWS could not be reached. Try again in a moment.", "unreachable");
    }

    const text = await response.text().catch(() => "");
    let payload: unknown = null;
    if (text) {
        try {
            payload = JSON.parse(text) as unknown;
        } catch {
            // STS answers in XML, and an error page from something in the way is
            // neither. Both are handled by the caller reading `text` instead.
            payload = null;
        }
    }

    if (response.status === 401 || response.status === 403) {
        throw new AwsError(detailOf(payload) || "AWS refused those credentials.", "unauthorized");
    }
    if (!response.ok) {
        // Their invalid-token errors arrive as 400 with the reason in the body,
        // which is a credential problem wearing a request problem's status.
        const said = detailOf(payload) || text.slice(0, 200);
        const credentialProblem = /security token|not authorized|access denied|signature/i.test(said);
        throw new AwsError(
            said || `AWS refused the request (HTTP ${response.status}).`,
            credentialProblem ? "unauthorized" : "refused"
        );
    }
    return payload ?? text;
}

/** The one line of an error body worth showing. */
function detailOf(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const body = payload as { message?: unknown; Message?: unknown; __type?: unknown };
    const message = body.message ?? body.Message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 200);
    return typeof body.__type === "string" ? body.__type.split("#").at(-1) ?? "" : "";
}

/* -------------------------------------------------------------------------- */
/* Who the keys belong to                                                     */
/* -------------------------------------------------------------------------- */

export interface AwsIdentity {
    readonly account: string;
    readonly arn: string;
    readonly userId: string;
}

/** One tag out of their XML. Three fields, one shape, and no reason to carry a
 *  parser for it - this is the only XML in Polaris. */
function tag(xml: string, name: string): string {
    const found = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
    return found?.[1]?.trim() ?? "";
}

/**
 * Who these keys are, which is also the check that they work.
 *
 * AWS grants this to everybody - it needs no permission at all - so it says
 * whether a key is live without needing the account to have given Polaris
 * anything yet. Everything else here needs a policy, and this is what tells a
 * wrong key apart from a key with too little attached to it.
 */
export async function awsIdentity(credentials: AwsCredentials): Promise<AwsIdentity> {
    const answer = await call({
        credentials,
        service: "sts",
        body: "Action=GetCallerIdentity&Version=2011-06-15",
        contentType: "application/x-www-form-urlencoded"
    });
    const xml = typeof answer === "string" ? answer : "";
    const account = tag(xml, "Account");
    if (!account) throw new AwsError("AWS answered with something unexpected.", "refused");
    return { account, arn: tag(xml, "Arn"), userId: tag(xml, "UserId") };
}

/* -------------------------------------------------------------------------- */
/* ECS, which is where Fargate lives                                          */
/* -------------------------------------------------------------------------- */

const ECS = "AmazonEC2ContainerServiceV20141113";

const arnListSchema = z.object({ clusterArns: z.array(z.string()).default([]) });
const serviceArnsSchema = z.object({ serviceArns: z.array(z.string()).default([]) });

/** The last part of an ARN, which is the only part anybody reads. */
export function arnName(arn: string): string {
    return arn.split("/").at(-1) || arn.split(":").at(-1) || arn;
}

export async function ecsClusters(credentials: AwsCredentials): Promise<string[]> {
    const parsed = arnListSchema.safeParse(
        await call({ credentials, service: "ecs", target: `${ECS}.ListClusters`, body: { maxResults: 100 } })
    );
    if (!parsed.success) throw new AwsError("AWS answered with something unexpected.", "refused");
    return parsed.data.clusterArns;
}

export async function ecsServices(credentials: AwsCredentials, cluster: string): Promise<string[]> {
    const parsed = serviceArnsSchema.safeParse(
        await call({
            credentials,
            service: "ecs",
            target: `${ECS}.ListServices`,
            body: { cluster, maxResults: 100 }
        })
    );
    if (!parsed.success) throw new AwsError("AWS answered with something unexpected.", "refused");
    return parsed.data.serviceArns;
}

const ecsDeploymentSchema = z.object({
    id: z.string().default(""),
    /** PRIMARY | ACTIVE | INACTIVE. */
    status: z.string().default(""),
    /** COMPLETED | FAILED | IN_PROGRESS - absent on an older deployment. */
    rolloutState: z.string().default(""),
    rolloutStateReason: z.string().default(""),
    taskDefinition: z.string().default(""),
    runningCount: z.number().default(0),
    desiredCount: z.number().default(0),
    failedTasks: z.number().default(0),
    createdAt: z.number().nullable().default(null),
    updatedAt: z.number().nullable().default(null)
});

const ecsServiceSchema = z.object({
    serviceName: z.string().default(""),
    serviceArn: z.string().default(""),
    /** ACTIVE | DRAINING | INACTIVE. */
    status: z.string().default(""),
    runningCount: z.number().default(0),
    desiredCount: z.number().default(0),
    deployments: z.array(ecsDeploymentSchema).default([])
});

export type EcsService = z.infer<typeof ecsServiceSchema>;

/** One service, whole. Their describe takes up to ten at a time; Polaris asks
 *  about the one it is drawing. */
export async function ecsService(
    credentials: AwsCredentials,
    cluster: string,
    service: string
): Promise<EcsService | null> {
    const parsed = z
        .object({ services: z.array(ecsServiceSchema).default([]) })
        .safeParse(
            await call({
                credentials,
                service: "ecs",
                target: `${ECS}.DescribeServices`,
                body: { cluster, services: [service] }
            })
        );
    if (!parsed.success) throw new AwsError("AWS answered with something unexpected.", "refused");
    return parsed.data.services[0] ?? null;
}

/**
 * Release it again.
 *
 * `forceNewDeployment` is their own way of saying "start the tasks again with
 * what the task definition points at now" - which is what redeploying means for a
 * service whose image tag has not changed, and the only honest reading of a
 * Deploy button for a service Polaris did not build.
 */
export async function ecsRedeploy(
    credentials: AwsCredentials,
    cluster: string,
    service: string
): Promise<void> {
    await call({
        credentials,
        service: "ecs",
        target: `${ECS}.UpdateService`,
        body: { cluster, service, forceNewDeployment: true }
    });
}

/* -------------------------------------------------------------------------- */
/* Amplify                                                                    */
/* -------------------------------------------------------------------------- */

const amplifyAppSchema = z.object({
    appId: z.string().default(""),
    name: z.string().default(""),
    defaultDomain: z.string().default(""),
    repository: z.string().default(""),
    platform: z.string().default(""),
    productionBranch: z
        .object({
            branchName: z.string().default(""),
            status: z.string().default(""),
            lastDeployTime: z.number().nullable().default(null)
        })
        .nullable()
        .default(null)
});

export type AmplifyApp = z.infer<typeof amplifyAppSchema>;

export async function amplifyApps(credentials: AwsCredentials): Promise<AmplifyApp[]> {
    const parsed = z
        .object({ apps: z.array(amplifyAppSchema).default([]) })
        .safeParse(
            await call({
                credentials,
                service: "amplify",
                method: "GET",
                path: "/apps",
                query: "maxResults=100",
                contentType: "application/json"
            })
        );
    if (!parsed.success) throw new AwsError("AWS answered with something unexpected.", "refused");
    return parsed.data.apps;
}

const branchSchema = z.object({
    branchName: z.string().default(""),
    displayName: z.string().default(""),
    stage: z.string().default("")
});

export async function amplifyBranches(
    credentials: AwsCredentials,
    appId: string
): Promise<{ branchName: string; stage: string }[]> {
    const parsed = z
        .object({ branches: z.array(branchSchema).default([]) })
        .safeParse(
            await call({
                credentials,
                service: "amplify",
                method: "GET",
                path: `/apps/${encodeURIComponent(appId)}/branches`,
                query: "maxResults=50",
                contentType: "application/json"
            })
        );
    if (!parsed.success) throw new AwsError("AWS answered with something unexpected.", "refused");
    return parsed.data.branches.map((branch) => ({ branchName: branch.branchName, stage: branch.stage }));
}

const jobSchema = z.object({
    jobId: z.string().default(""),
    /** PENDING | PROVISIONING | RUNNING | FAILED | SUCCEED | CANCELLING | CANCELLED. */
    status: z.string().default(""),
    jobType: z.string().default(""),
    commitId: z.string().default(""),
    commitMessage: z.string().default(""),
    startTime: z.number().nullable().default(null),
    endTime: z.number().nullable().default(null)
});

export type AmplifyJob = z.infer<typeof jobSchema>;

/** The most recent builds of one branch, newest first as they return them. */
export async function amplifyJobs(
    credentials: AwsCredentials,
    appId: string,
    branch: string
): Promise<AmplifyJob[]> {
    const parsed = z
        .object({ jobSummaries: z.array(jobSchema).default([]) })
        .safeParse(
            await call({
                credentials,
                service: "amplify",
                method: "GET",
                path: `/apps/${encodeURIComponent(appId)}/branches/${encodeURIComponent(branch)}/jobs`,
                query: "maxResults=5",
                contentType: "application/json"
            })
        );
    if (!parsed.success) throw new AwsError("AWS answered with something unexpected.", "refused");
    return parsed.data.jobSummaries;
}

/** Build the branch again from its latest commit, which is what their own
 *  "redeploy this version" does. */
export async function amplifyRelease(
    credentials: AwsCredentials,
    appId: string,
    branch: string
): Promise<void> {
    await call({
        credentials,
        service: "amplify",
        method: "POST",
        path: `/apps/${encodeURIComponent(appId)}/branches/${encodeURIComponent(branch)}/jobs`,
        body: { jobType: "RELEASE", jobReason: "Released from Polaris" },
        contentType: "application/json"
    });
}
