/**
 * What each of a scope's variables points at, when it is a `${{name.KEY}}`
 * reference rather than a value: the service, database or shared variables it
 * names, and whether that has the key.
 *
 * A secret is opened to look for references, and only the reference comes back
 * - the name and key as written, never any literal around them - so a secret
 * holding `${{postgres.DATABASE_URL}}` can say it is linked without its value
 * reaching the page. What a name means is the same as at deploy time
 * (`references.ts`): `shared`, then a service by slug or name, then a database.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { slugify } from "@polaris/deploy";
import { decryptedValue } from "./env-values";

export interface VariableLink {
    /** Exactly as written, e.g. `${{postgres.DATABASE_URL}}`. */
    written: string;
    name: string;
    key: string;
    /** What the name is in this environment, or null when nothing is called that. */
    target: { kind: "shared" | "service" | "database"; label: string } | null;
    /** Whether the target has that key. False for a target that does not exist. */
    keyKnown: boolean;
}

/** The keys a service is described by, besides the ones set on it (see `references.ts`). */
const SERVICE_KEYS = ["POLARIS_PRIVATE_DOMAIN", "PORT", "POLARIS_PUBLIC_DOMAIN", "POLARIS_PUBLIC_URL"];

/** The keys a managed database answers to; the values do not matter here. */
function databaseKeys(engine: string): Set<string> {
    return new Set(
        Object.keys(
            core.databaseReferenceKeys({ engine, host: "", port: 0, database: "", username: "", password: "", uri: "" })
        )
    );
}

/** Links for every variable of one scope that has any, keyed by variable id. Callers authorize the scope. */
export async function variableLinks(
    scope: "application" | "environment",
    scopeId: string
): Promise<Record<string, VariableLink[]>> {
    const rows = await prisma.envVar.findMany({ where: { scopeType: scope, scopeId } });
    const found = new Map<string, core.VariableReference[]>();
    for (const row of rows) {
        let value: string | null = null;
        try {
            value = decryptedValue(row);
        } catch {
            // A secret that will not open has nothing to say about links.
        }
        const references = value ? core.referencesIn(value) : [];
        if (references.length > 0) found.set(row.id, references);
    }
    if (found.size === 0) return {};

    const environmentId =
        scope === "environment"
            ? scopeId
            : (await prisma.application.findUnique({ where: { id: scopeId }, select: { environmentId: true } }))
                  ?.environmentId;
    if (!environmentId) return {};

    const [applications, databases, shared] = await Promise.all([
        prisma.application.findMany({ where: { environmentId }, select: { id: true, slug: true, name: true } }),
        prisma.managedDatabase.findMany({ where: { environmentId }, select: { slug: true, name: true, engine: true } }),
        prisma.envVar.findMany({ where: { scopeType: "environment", scopeId: environmentId }, select: { key: true } })
    ]);
    const serviceKeys = new Map<string, Set<string>>();
    const named = [...new Set([...found.values()].flat().map((reference) => reference.name))];
    const linkedApps = applications.filter((app) => named.includes(app.slug) || named.includes(slugify(app.name)));
    if (linkedApps.length > 0) {
        const keys = await prisma.envVar.findMany({
            where: { scopeType: "application", scopeId: { in: linkedApps.map((app) => app.id) } },
            select: { scopeId: true, key: true }
        });
        for (const app of linkedApps) serviceKeys.set(app.id, new Set(SERVICE_KEYS));
        for (const row of keys) serviceKeys.get(row.scopeId)?.add(row.key);
    }
    const sharedKeys = new Set(shared.map((row) => row.key));

    function link(reference: core.VariableReference): VariableLink {
        const base = { written: reference.written, name: reference.name, key: reference.key };
        if (reference.name === "shared") {
            return { ...base, target: { kind: "shared", label: "Shared variables" }, keyKnown: sharedKeys.has(reference.key) };
        }
        const app = applications.find((one) => one.slug === reference.name || slugify(one.name) === reference.name);
        if (app) {
            return {
                ...base,
                target: { kind: "service", label: app.name },
                keyKnown: serviceKeys.get(app.id)?.has(reference.key) ?? false
            };
        }
        const database = databases.find((one) => one.slug === reference.name || slugify(one.name) === reference.name);
        if (database) {
            return {
                ...base,
                target: { kind: "database", label: database.name },
                keyKnown: databaseKeys(database.engine).has(reference.key)
            };
        }
        return { ...base, target: null, keyKnown: false };
    }

    const out: Record<string, VariableLink[]> = {};
    for (const [id, references] of found) out[id] = references.map(link);
    return out;
}
