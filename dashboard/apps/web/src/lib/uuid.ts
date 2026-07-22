/**
 * Postgres `@db.Uuid` columns cannot be compared against a non-UUID string - the
 * driver raises `invalid input syntax for type uuid` rather than returning empty.
 * Some Drive sources are browsed under an ephemeral, non-UUID connection id (a
 * deployed app's container is `container:<appId>`), so any query that filters such
 * a column by connection id must first check this and treat a non-UUID id as a
 * clean no-op instead of letting the query throw.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(id: string): boolean {
    return UUID_RE.test(id);
}
