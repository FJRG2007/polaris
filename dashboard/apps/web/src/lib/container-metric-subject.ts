import { createHash } from "node:crypto";

/**
 * The metric subject one container's history is filed under.
 *
 * A container is not a stable thing to key on: a redeploy or an image update
 * replaces it with a new id. What stays is the host it runs on and its name,
 * which is also how its page is addressed (`/apps/containers/<name>?c=<host>`),
 * so the history follows the name across replacements. The samples table keys
 * subjects by UUID, so the pair is hashed into one: deterministic, so the
 * collector and the page arrive at the same id without a lookup table, and not
 * guessable into another host's containers, since reading it back still goes
 * through the host's own authorization first.
 */
export function containerMetricSubject(connectionId: string, name: string): string {
    const bare = name.startsWith("/") ? name.slice(1) : name;
    const hex = createHash("sha256").update(`container\u0000${connectionId}\u0000${bare}`).digest("hex");
    // Shaped as a version-8 (custom) UUID so the column's type accepts it.
    const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
