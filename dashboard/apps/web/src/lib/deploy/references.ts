/**
 * Resolving `${{name.KEY}}` references for one service, inside its environment.
 *
 * The pure half - finding and substituting references - is in `@polaris/core`
 * (`deploy-references`). This is what a name means here:
 *
 * - `shared` is the environment's own variables.
 * - a service, by slug or by name, answers with its own variables, plus four
 *   that describe it rather than being set on it: `POLARIS_PRIVATE_DOMAIN` (the
 *   name other containers reach it by), `PORT`, `POLARIS_PUBLIC_DOMAIN` and
 *   `POLARIS_PUBLIC_URL`.
 * - a managed database answers with how to connect to it (`databaseReferenceKeys`),
 *   and an object store with its endpoint and S3 keys the same way.
 *
 * Only names that actually appear are read, so a service with no references
 * costs nothing, and one that names a database costs one credential decrypt.
 * Everything is looked up inside the service's own environment - which is the
 * point: a clone of it finds the clone's database under the same name.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { slugify } from "@polaris/deploy";
import { scopeValues } from "./env-values";
import { currentReleaseRef } from "./releases";

/** The variables a service is described by, besides the ones set on it. */
const SERVICE_KEYS = ["POLARIS_PRIVATE_DOMAIN", "PORT", "POLARIS_PUBLIC_DOMAIN", "POLARIS_PUBLIC_URL"] as const;

interface Scope {
    readonly environmentId: string;
    readonly applicationId: string;
    readonly ownerId: string;
}

/** Everything a name can resolve to, loaded for the names in use. */
type Values = Map<string, Record<string, string>>;

/**
 * Resolve the references in one service's variables.
 *
 * Answers the variables with every reference it could resolve substituted, and
 * the ones it could not, as written - the deploy refuses on those rather than
 * starting a service with `${{...}}` in its connection string.
 *
 * Throws, naming the variable, on a value no container can be given: one that
 * holds a control character, or grows past the limit once resolved. Checked
 * here because this is the last point every variable of a deploy passes before
 * the host daemon, which would otherwise refuse it in words of its own.
 */
export async function resolveServiceReferences(
    env: Readonly<Record<string, string>>,
    scope: Scope
): Promise<{ env: Record<string, string>; unresolved: string[] }> {
    if (!Object.values(env).some(core.hasReferences)) {
        core.assertEnvValues(env);
        return { env: { ...env }, unresolved: [] };
    }

    const values: Values = new Map();
    // As many rounds as substitution follows: the names this service uses, then
    // any those values use in turn.
    let pending = namesIn(Object.values(env));
    for (let round = 0; round < core.REFERENCE_DEPTH && pending.size > 0; round += 1) {
        const loaded = await loadNames(pending, scope, values);
        pending = new Set([...namesIn(loaded)].filter((name) => !values.has(name)));
    }
    const resolved = core.resolveReferences(env, (name, key) => values.get(name)?.[key]);
    core.assertEnvValues(resolved.env);
    return resolved;
}

function namesIn(texts: Iterable<string>): Set<string> {
    const names = new Set<string>();
    for (const text of texts) for (const reference of core.referencesIn(text)) names.add(reference.name);
    return names;
}

/** Load what each name means into `values`, and answer every value loaded, so
 *  the caller can look for references inside them. */
async function loadNames(names: Set<string>, scope: Scope, values: Values): Promise<string[]> {
    const texts: string[] = [];
    const remember = (name: string, record: Record<string, string>): void => {
        values.set(name, record);
        texts.push(...Object.values(record));
    };

    if (names.has("shared")) remember("shared", await scopeValues("environment", scope.environmentId));

    const wanted = [...names].filter((name) => name !== "shared");
    if (wanted.length === 0) return texts;

    const [applications, databases] = await Promise.all([
        prisma.application.findMany({
            where: { environmentId: scope.environmentId },
            select: {
                id: true,
                slug: true,
                name: true,
                sourceType: true,
                sourceConfig: true,
                currentDeploymentId: true,
                environment: { select: { project: { select: { slug: true } } } },
                domains: {
                    where: { enabled: true, deploymentId: null },
                    select: { hostname: true, kind: true, targetPort: true },
                    orderBy: { createdAt: "asc" }
                }
            }
        }),
        prisma.managedDatabase.findMany({
            where: { environmentId: scope.environmentId },
            select: { id: true, slug: true, name: true, engine: true }
        })
    ]);

    for (const name of wanted) {
        const application = applications.find((one) => one.slug === name || slugify(one.name) === name);
        if (application) {
            remember(name, {
                ...(await scopeValues("application", application.id)),
                ...(await describeService(application))
            });
            continue;
        }
        const database = databases.find((one) => one.slug === name || slugify(one.name) === name);
        if (database) {
            // Cycle: database-service reaches the deploy service, which reaches this.
            const { databaseConnection } = await import("@/lib/database-service");
            const connection = await databaseConnection(database.id, scope.ownerId).catch(() => null);
            // A database never deployed has no address yet; the reference stays
            // unresolved and the refusal says which one.
            if (connection) remember(name, core.databaseReferenceKeys({ engine: database.engine, ...connection }));
        }
    }
    return texts;
}

/** The keys a service is described by. */
async function describeService(application: {
    id: string;
    slug: string;
    sourceType: string;
    sourceConfig: string;
    currentDeploymentId: string | null;
    environment: { project: { slug: string } };
    domains: { hostname: string; kind: string; targetPort: number }[];
}): Promise<Record<(typeof SERVICE_KEYS)[number], string>> {
    const release = await currentReleaseRef(application);
    let port: number | undefined;
    try {
        const source = JSON.parse(application.sourceConfig) as Record<string, unknown>;
        if (typeof source.port === "number") port = source.port;
    } catch {
        // A service whose stored config cannot be read falls back to its domain.
    }
    const domain = application.domains.find((one) => one.kind !== "lan") ?? application.domains[0];
    const containerPort = port ?? domain?.targetPort ?? (application.sourceType === "image" ? 80 : 3000);
    return {
        POLARIS_PRIVATE_DOMAIN: release.address,
        PORT: String(containerPort),
        POLARIS_PUBLIC_DOMAIN: domain?.hostname ?? "",
        POLARIS_PUBLIC_URL: domain ? `https://${domain.hostname}` : ""
    };
}
