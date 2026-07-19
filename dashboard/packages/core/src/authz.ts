/**
 * Pure authorization engine. Every access decision in Polaris - global
 * capabilities, per-file Drive access, and policy documents written by an admin -
 * is expressed as a list of allow/deny statements over (action, resource) pairs
 * and resolved here. The model is deliberately small and deterministic:
 *
 *   - Deny by default: an action with no matching allow is denied.
 *   - Explicit deny wins: a single matching deny overrides every allow.
 *
 * This matches the mental model of IAM-style policies without any I/O, so it is
 * trivially testable and safe to import from either the server or the client.
 * Callers compile their world (roles, groups, ACL rows, ownership) into
 * statements and hand them to `evaluateStatements`; this module never touches a
 * database.
 */

import { z } from "zod";

/** The distinct verbs a Drive resource can be acted on with. */
export const DRIVE_ACTIONS = ["read", "write", "rename", "delete", "copy", "download"] as const;

export type DriveAction = (typeof DRIVE_ACTIONS)[number];

/** One allow/deny rule over a set of action and resource patterns. */
export interface PolicyStatement {
    effect: "allow" | "deny";
    /** Action patterns (e.g. "drive.read", "users.manage", or "*"). */
    actions: readonly string[];
    /** Resource patterns (e.g. "drive:cxx:reports/*", "*"). */
    resources: readonly string[];
}

/** A named bundle of statements, as stored on a Policy row. */
export interface PolicyDocument {
    statements: PolicyStatement[];
}

/** The outcome of evaluating a request against a set of statements. */
export type AuthzDecision = "allow" | "deny" | "implicit-deny";

/** Zod schema for a single statement, used to validate admin-authored policies. */
export const policyStatementSchema = z.object({
    effect: z.enum(["allow", "deny"]),
    actions: z.array(z.string().min(1)).min(1),
    resources: z.array(z.string().min(1)).min(1)
});

/** Zod schema for a whole policy document. */
export const policyDocumentSchema = z.object({
    statements: z.array(policyStatementSchema).min(1)
});

/**
 * Glob match where `*` stands for any run of characters (including none) and
 * crosses the resource separators (`:` and `/`), so `drive:cxx:*` covers every
 * path in a connection. Everything else is a literal, case-sensitive match. No
 * regex is involved, so a pattern can never be a denial-of-service vector.
 */
export function matchesGlob(pattern: string, value: string): boolean {
    if (pattern === "*") return true;
    const parts = pattern.split("*");
    if (parts.length === 1) return pattern === value;

    // Anchor the first and last literal segments, then walk the middle ones in
    // order. A leading/trailing "*" yields an empty first/last part, which the
    // startsWith/endsWith checks accept.
    const first = parts[0] as string;
    const last = parts[parts.length - 1] as string;
    if (!value.startsWith(first)) return false;
    if (!value.endsWith(last)) return false;

    let cursor = first.length;
    for (let index = 1; index < parts.length - 1; index++) {
        const segment = parts[index] as string;
        if (segment.length === 0) continue;
        const found = value.indexOf(segment, cursor);
        if (found === -1 || found + segment.length > value.length - last.length) return false;
        cursor = found + segment.length;
    }
    return true;
}

/**
 * Resolve a request against a flat list of statements. Deny-by-default with
 * explicit-deny-override: the first matching deny short-circuits to "deny";
 * otherwise a matching allow yields "allow"; with neither, "implicit-deny".
 */
export function evaluateStatements(
    statements: Iterable<PolicyStatement>,
    action: string,
    resource: string
): AuthzDecision {
    let allowed = false;
    for (const statement of statements) {
        if (!statement.actions.some((pattern) => matchesGlob(pattern, action))) continue;
        if (!statement.resources.some((pattern) => matchesGlob(pattern, resource))) continue;
        if (statement.effect === "deny") return "deny";
        allowed = true;
    }
    return allowed ? "allow" : "implicit-deny";
}

/** Convenience boolean wrapper over `evaluateStatements`. */
export function isAllowed(
    statements: Iterable<PolicyStatement>,
    action: string,
    resource: string
): boolean {
    return evaluateStatements(statements, action, resource) === "allow";
}

/** Canonical resource string for a Drive path within a connection. */
export function driveResource(connectionId: string, path: string): string {
    return `drive:${connectionId}:${path}`;
}

/**
 * The resource patterns a subtree grant on `path` should match: the item itself
 * and everything beneath it. An empty path grants the whole connection.
 */
export function driveResourcePatterns(connectionId: string, path: string): string[] {
    if (path === "") return [`drive:${connectionId}:*`];
    return [`drive:${connectionId}:${path}`, `drive:${connectionId}:${path}/*`];
}
