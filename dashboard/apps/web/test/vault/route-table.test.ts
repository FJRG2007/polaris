/**
 * The real route table, checked against itself.
 *
 * `dispatchVault` takes the first route that matches, so a capture listed above
 * a literal of the same shape swallows it: `PUT api/ciphers/:id` written before
 * `PUT api/ciphers/delete` turns every bulk delete into an edit of an item
 * called "delete", which parses badly and answers 400 - a correct request
 * refused, with nothing in the table that looks wrong.
 *
 * This is the check that cannot be done by reading the file, so it is done here.
 */

import { describe, expect, it, vi } from "vitest";

// The table pulls in the whole service layer through its handlers. None of it
// runs here - only the shape of the table is read - but the modules load, and
// they refuse to without an environment. These are throwaway values.
process.env.POLARIS_DATABASE_URL ??= "postgresql://polaris:polaris@127.0.0.1:5432/polaris";
process.env.POLARIS_AUTH_SECRET ??= "test-auth-secret-test-auth-secret-32";
process.env.POLARIS_MASTER_KEY ??= "test-master-key-test-master-key-32ab";
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("server-only", () => ({}));

const { VAULT_ROUTES } = await import("../../src/lib/vault/api/routes");
const { matchRoute } = await import("../../src/lib/vault/api/router");

/** A path a route would actually be called on, with its captures filled in. */
function sampleSegments(path: string): string[] {
    return path
        .split("/")
        .filter(Boolean)
        .map((part, index) =>
            part.startsWith(":") ? `9e107d9d-372b-4939-a3ee-${index}00000000000` : part
        );
}

describe("VAULT_ROUTES", () => {
    it("has no route shadowed by an earlier one", () => {
        const shadowed: string[] = [];
        for (let later = 0; later < VAULT_ROUTES.length; later += 1) {
            const route = VAULT_ROUTES[later]!;
            const segments = sampleSegments(route.path);
            for (let earlier = 0; earlier < later; earlier += 1) {
                const other = VAULT_ROUTES[earlier]!;
                if (other.method !== route.method) continue;
                if (matchRoute(other.path, segments)) {
                    shadowed.push(`${route.method} ${route.path} <- ${other.path}`);
                    break;
                }
            }
        }
        expect(shadowed).toEqual([]);
    });

    it("lists no path twice under one method", () => {
        const seen = new Set<string>();
        const duplicates: string[] = [];
        for (const route of VAULT_ROUTES) {
            const key = `${route.method} ${route.path.toLowerCase()}`;
            if (seen.has(key)) duplicates.push(key);
            seen.add(key);
        }
        expect(duplicates).toEqual([]);
    });

    it("keeps the open routes to the ones that cannot carry a token", () => {
        // A route added here without noticing is a vault endpoint anybody can
        // reach, so the list is written out rather than counted.
        const open = VAULT_ROUTES.filter((route) => route.auth === "none").map(
            (route) => `${route.method} ${route.path}`
        );
        expect(open.sort()).toEqual([
            "GET api/alive",
            "GET api/config",
            "GET api/devices/knowndevice",
            "GET api/devices/knowndevice/:email/:identifier",
            "GET api/now",
            "GET api/version",
            "GET icons/:domain/icon.png",
            "POST api/accounts/prelogin",
            "POST api/sends/access/:id",
            "POST identity/accounts/prelogin",
            "POST identity/accounts/register",
            "POST identity/connect/token",
            "POST notifications/hub/negotiate"
        ]);
    });
});
