/**
 * Deterministic naming for deployed resources. Container/service names double as
 * DNS hostnames on the shared proxy network, so they must be DNS-label-safe;
 * image tags carry the commit SHA so an unchanged commit reuses (and can roll
 * back to) an already-built image. All functions are pure.
 */

import { createHash } from "node:crypto";

/** Lower-case, DNS-label-safe slug: [a-z0-9-], no leading/trailing/double dashes. */
export function slugify(input: string): string {
    return input
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-")
        .slice(0, 63);
}

/** Short stable hash (hex) of an input, for uniqueness suffixes. */
export function shortHash(input: string, length = 6): string {
    return createHash("sha256").update(input).digest("hex").slice(0, length);
}

/** Container/service name for an application: `<project>-<app>` slugged, with a
 *  short id suffix so two apps that slug identically never collide. */
export function serviceName(projectSlug: string, appSlug: string, id: string): string {
    const base = slugify(`${projectSlug}-${appSlug}`);
    return `${base}-${shortHash(id, 4)}`.slice(0, 63);
}

/** Image tag for a build: `<name>:<commit|latest>`. A commit-pinned tag lets an
 *  unchanged commit skip the build and lets a rollback re-point at a prior image. */
export function imageTag(name: string, commitSha?: string): string {
    const version = commitSha ? commitSha.slice(0, 12) : "latest";
    return `${slugify(name)}:${version}`;
}
