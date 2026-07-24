/**
 * Shared gate for the public share endpoints. A share link carries no session -
 * the token (plus any password) is the credential - so every request must pass
 * the exact same server-side checks before any listing or bytes are served: the
 * share exists and is usable (unexpired, unrevoked, under its cap), the client IP
 * clears the CIDR/geo/fraud rules, and the password gate (unlock cookie) is
 * satisfied. Centralizing the checks here keeps the list, zip, search, and
 * download routes in lockstep so a gap can never open up between them.
 */

import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import {
    logShareAccess,
    resolveShareByToken,
    shareGeoAllowed,
    shareIpAllowed,
    shareUnlockCookie,
    shareUsability,
    verifyShareUnlock,
    type ShareRecord
} from "@/lib/share-service";
import { clientIp, clientUserAgent, hashForLog } from "@/lib/request-context";
import { dymoIpAllowed } from "@/lib/dymo-service";

/** A share that has cleared every access gate, with the resolved request context. */
export type ShareGate =
    | {
          ok: true;
          share: NonNullable<ShareRecord>;
          ip: string | undefined;
          ipHash: string | undefined;
          userAgentHash: string | undefined;
      }
    | { ok: false; status: number; reason: string };

/**
 * Resolve a share by token and run every access gate in the same order as the
 * download path. On any failure the denial is logged (best-effort) with the given
 * action label and returned as a status/reason for the caller to shape into its
 * own response. Success does not log - each route records its own action.
 */
export async function gateShareRequest(token: string, action: string): Promise<ShareGate> {
    const share = await resolveShareByToken(token);
    if (!share) return { ok: false, status: 404, reason: "not_found" };

    const ip = await clientIp();
    const ipHash = hashForLog(ip);
    const userAgentHash = hashForLog(await clientUserAgent());
    const deny = (status: number, reason: string): ShareGate => {
        void logShareAccess({ shareId: share.id, action, reason, ip, ipHash, userAgentHash });
        return { ok: false, status, reason };
    };

    const usable = shareUsability(share);
    if (!usable.ok) return deny(410, usable.reason);

    if (!shareIpAllowed(share.allowedCidrs, ip)) return deny(403, "ip_not_allowed");

    if (!(await shareGeoAllowed(share.allowedCountries, share.allowedContinents, ip))) {
        return deny(403, "country_not_allowed");
    }

    // Dymo IP-fraud gate (no-op unless the integration is enabled). Fails open.
    if (!(await dymoIpAllowed(ip)).allowed) return deny(403, "ip_flagged");

    if (share.passwordHash) {
        const cookieValue = (await cookies()).get(shareUnlockCookie(share.id))?.value;
        if (!verifyShareUnlock(share.id, cookieValue, loadEnv().POLARIS_AUTH_SECRET)) {
            return deny(401, "password_required");
        }
    }

    return { ok: true, share, ip, ipHash, userAgentHash };
}
