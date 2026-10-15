/**
 * Promoting one environment of a project into another - staging into
 * production, development into staging.
 *
 * A promotion pairs each service and database in the source with the one of
 * the same slug in the target (a copied environment keeps its slugs), so what
 * is overwritten is decided here, by a pure function, and the confirmation the
 * reader sees and the work that runs read the same plan.
 */

import { z } from "zod";
import type { MaintenanceCommand } from "./schemas/database-maintenance.js";

/** What an environment is for, in the order work moves through them. */
export const ENVIRONMENT_STAGES = ["development", "staging", "production"] as const;
export type EnvironmentStage = (typeof ENVIRONMENT_STAGES)[number];

export const environmentStageSchema = z.object({
    environmentId: z.string().uuid(),
    /** Null clears it. */
    stage: z.enum(ENVIRONMENT_STAGES).nullable()
});

export const environmentPromotionSchema = z
    .object({
        sourceEnvironmentId: z.string().uuid(),
        targetEnvironmentId: z.string().uuid(),
        /** Replace each paired database's contents with the source's too. */
        includeData: z.boolean().default(false)
    })
    .refine((value) => value.sourceEnvironmentId !== value.targetEnvironmentId, {
        message: "Pick two different environments",
        path: ["targetEnvironmentId"]
    });

export type EnvironmentPromotionInput = z.infer<typeof environmentPromotionSchema>;

/**
 * The stage an environment is for. One nobody marked reads as production when
 * it is the project's default - the one a bare link lands on - and as nothing
 * otherwise, so a project made before stages existed needs no backfill.
 */
export function effectiveStage(environment: {
    readonly stage: string | null;
    readonly isDefault: boolean;
}): EnvironmentStage | null {
    const parsed = z.enum(ENVIRONMENT_STAGES).safeParse(environment.stage);
    if (parsed.success) return parsed.data;
    return environment.isDefault ? "production" : null;
}

/** The environment a promotion out of `stage` usually goes to. */
export function nextStage(stage: EnvironmentStage | null): EnvironmentStage | null {
    if (stage === "development") return "staging";
    if (stage === "staging") return "production";
    return null;
}

export interface PromotableService {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
}

export interface PromotableDatabase extends PromotableService {
    readonly engine: string;
    /** A database hosted inside an instance, or an instance of its own. */
    readonly parentId?: string | null;
}

export interface PromotionPair {
    readonly name: string;
    readonly sourceId: string;
    readonly targetId: string;
}

export interface PromotionPlan {
    /** Services the target runs that take the source's release. */
    readonly services: readonly PromotionPair[];
    /** Databases whose contents the source's would replace. */
    readonly databases: readonly PromotionPair[];
    /** What the source has and the target cannot take, with why. */
    readonly skipped: readonly {
        readonly kind: "service" | "database";
        readonly name: string;
        readonly reason: "missing" | "engine";
    }[];
}

/** Engines whose dumps load into each other. */
function engineFamily(engine: string): string {
    return engine === "mariadb" ? "mysql" : engine;
}

/**
 * Pair the source's services and databases with the target's by slug. The
 * target's own extras are left as they are: a promotion overwrites, it never
 * removes.
 */
export function planPromotion(
    source: { readonly services: readonly PromotableService[]; readonly databases: readonly PromotableDatabase[] },
    target: { readonly services: readonly PromotableService[]; readonly databases: readonly PromotableDatabase[] }
): PromotionPlan {
    const services: PromotionPair[] = [];
    const databases: PromotionPair[] = [];
    const skipped: PromotionPlan["skipped"][number][] = [];
    const targetServices = new Map(target.services.map((service) => [service.slug, service]));
    const targetDatabases = new Map(target.databases.map((database) => [database.slug, database]));
    for (const service of [...source.services].sort((a, b) => a.name.localeCompare(b.name))) {
        const into = targetServices.get(service.slug);
        if (into) services.push({ name: into.name, sourceId: service.id, targetId: into.id });
        else skipped.push({ kind: "service", name: service.name, reason: "missing" });
    }
    for (const database of [...source.databases].sort((a, b) => a.name.localeCompare(b.name))) {
        const into = targetDatabases.get(database.slug);
        if (!into) skipped.push({ kind: "database", name: database.name, reason: "missing" });
        else if (engineFamily(into.engine) !== engineFamily(database.engine))
            skipped.push({ kind: "database", name: database.name, reason: "engine" });
        else databases.push({ name: into.name, sourceId: database.id, targetId: into.id });
    }
    return { services, databases, skipped };
}

/** A host name as the edge routes it: letters, digits, dots, dashes, a port. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/;
/** A WordPress table prefix as wp-config.php allows it. */
const TABLE_PREFIX = /^[A-Za-z0-9_]{0,48}$/;

interface SqlClient {
    readonly engine: "mysql" | "mariadb";
    readonly username: string;
    readonly password: string;
    readonly database: string;
}

function sqlCommand(client: SqlClient, sql: string, describe: string): MaintenanceCommand {
    // The password rides the argv of a process inside the database's own
    // container, the channel the readiness probe uses.
    return {
        argv: [
            client.engine === "mariadb" ? "mariadb" : "mysql",
            `-u${client.username}`,
            `-p${client.password}`,
            "-N",
            "-B",
            client.database,
            "-e",
            sql
        ],
        describe
    };
}

/**
 * List the WordPress installs in a database by the prefixes of their tables:
 * each one with both an options and a posts table. One line per prefix.
 */
export function wordpressPrefixesCommand(client: SqlClient): MaintenanceCommand {
    return sqlCommand(
        client,
        [
            "SELECT LEFT(o.table_name, CHAR_LENGTH(o.table_name) - 7) FROM information_schema.tables o",
            "JOIN information_schema.tables p ON p.table_schema = o.table_schema",
            "AND p.table_name = CONCAT(LEFT(o.table_name, CHAR_LENGTH(o.table_name) - 7), 'posts')",
            "WHERE o.table_schema = DATABASE() AND RIGHT(o.table_name, 7) = 'options'"
        ].join(" "),
        "Looking for WordPress tables"
    );
}

/** The prefixes a `wordpressPrefixesCommand` printed, each one checked. */
export function parseWordpressPrefixes(output: string): string[] {
    const prefixes = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.endsWith("_") && TABLE_PREFIX.test(line));
    return [...new Set(prefixes)].slice(0, 20);
}

/**
 * Point a copied WordPress at its new address. A dump carries the address it
 * was served at in `home` and `siteurl` - WordPress redirects every visit
 * there - and in links written into posts. Both are rewritten from `//from` to
 * `//to`, so http and https links move alike. Serialized values are left
 * alone: a plain replace would corrupt their recorded lengths.
 *
 * The hosts and prefixes are checked against what they can contain before
 * they reach the statement, which is how it stays a statement about them and
 * nothing else; a value that fails the check is refused, never cleaned up.
 */
export function wordpressAddressCommand(
    client: SqlClient,
    input: { readonly prefixes: readonly string[]; readonly from: string; readonly to: string }
): MaintenanceCommand | null {
    const from = input.from.toLowerCase();
    const to = input.to.toLowerCase();
    if (!HOSTNAME.test(from) || !HOSTNAME.test(to) || from === to) return null;
    const prefixes = input.prefixes.filter((prefix) => TABLE_PREFIX.test(prefix));
    if (prefixes.length === 0) return null;
    const statements = prefixes.flatMap((prefix) => [
        `UPDATE \`${prefix}options\` SET option_value = REPLACE(option_value, '//${from}', '//${to}') WHERE option_name IN ('home', 'siteurl');`,
        `UPDATE \`${prefix}posts\` SET post_content = REPLACE(post_content, '//${from}', '//${to}');`
    ]);
    return sqlCommand(client, statements.join(" "), `Pointing WordPress at ${to}`);
}
