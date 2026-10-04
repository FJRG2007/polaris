/**
 * What the CLI expects Polaris to answer, endpoint by endpoint.
 *
 * Every response is parsed through one of these before anything reads it: a
 * server from a different release, a proxy's error page or a captive portal all
 * answer in some other shape, and the CLI says so instead of printing
 * `undefined`. Fields the CLI does not use are left out and passed through
 * untouched, so a newer server adding one breaks nothing.
 */

import { z } from "zod";

/** POST /api/cli/authorize */
export const authorizeSchema = z.object({
    userCode: z.string().min(4),
    deviceCode: z.string().min(16),
    expiresAt: z.string(),
    pollMs: z.number().int().positive(),
    verificationPath: z.string().startsWith("/"),
    approvePath: z.string().startsWith("/")
});

const accountSchema = z.object({ id: z.string(), name: z.string(), email: z.string() });

/** POST /api/cli/authorize/claim */
export const claimSchema = z.discriminatedUnion("status", [
    z.object({ status: z.literal("pending") }),
    z.object({ status: z.literal("denied") }),
    z.object({ status: z.literal("expired") }),
    z.object({
        status: z.literal("approved"),
        token: z.string(),
        keyId: z.string(),
        scopes: z.array(z.string()),
        account: accountSchema
    })
]);

/** GET /api/v1/me */
export const meSchema = z.object({
    user: z.object({
        id: z.string(),
        name: z.string().nullable(),
        email: z.string(),
        username: z.string().nullable().optional()
    }),
    key: z.object({ id: z.string(), scopes: z.array(z.string()) })
});

const serviceLineSchema = z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.string()
});

/** GET /api/v1/deploy/projects */
export const projectsSchema = z.object({
    projects: z.array(
        z.object({
            id: z.string(),
            name: z.string(),
            slug: z.string(),
            role: z.string(),
            environments: z.array(
                z.object({
                    id: z.string(),
                    name: z.string(),
                    slug: z.string(),
                    isDefault: z.boolean(),
                    services: z.array(serviceLineSchema)
                })
            )
        })
    )
});

const named = z.object({ id: z.string(), name: z.string(), slug: z.string() });

/** GET /api/v1/deploy/services?ref= and /services/:id */
export const serviceSchema = z.object({
    service: z.object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        project: named,
        environment: named,
        status: z.string(),
        currentDeploymentId: z.string().nullable(),
        source: z.object({
            kind: z.string(),
            image: z.string().nullable(),
            repository: z.string().nullable(),
            branch: z.string().nullable(),
            port: z.number().nullable()
        }),
        autoDeploy: z.boolean(),
        domains: z.array(
            z.object({
                id: z.string(),
                hostname: z.string(),
                enabled: z.boolean(),
                certificate: z.string(),
                targetPort: z.number(),
                kind: z.string(),
                health: z.string()
            })
        )
    })
});

export type ServiceDetail = z.infer<typeof serviceSchema>["service"];

/** GET /api/v1/deploy/services/:id/deployments */
export const deploymentsSchema = z.object({
    deployments: z.array(
        z.object({
            id: z.string(),
            status: z.string(),
            error: z.string().nullable(),
            createdAt: z.string(),
            isCurrent: z.boolean(),
            commitMessage: z.string().nullable(),
            commitSha: z.string().nullable(),
            rollbackable: z.boolean()
        })
    )
});

/** GET /api/v1/deploy/services/:id/logs */
export const runtimeLogSchema = z.object({ log: z.string() });

/** GET /api/v1/deploy/deployments/:id */
export const buildLogSchema = z.object({
    id: z.string(),
    status: z.string(),
    error: z.string().nullable(),
    done: z.boolean(),
    log: z.string(),
    nextOffset: z.number().int().nonnegative()
});

/** POST /api/v1/deploy/services/:id/deploy */
export const deployStartedSchema = z.object({ deploymentId: z.string() });

/** POST /api/v1/deploy/services/:id/restart */
export const restartedSchema = z.object({ restarted: z.literal(true) });

/** Any refusal: `{ error }`, with the scope that was missing on a 403. */
export const refusalSchema = z.object({ error: z.string(), requiredScope: z.string().optional() });
