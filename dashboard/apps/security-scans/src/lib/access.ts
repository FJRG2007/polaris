/**
 * Who may use Security scans: the people who run the instance's servers.
 * Every screen, action and download asks this first; the scans reach every
 * server's volumes and the hosts themselves, so nothing narrower applies.
 *
 * Server-only.
 */

import { host } from "@polaris/app-host";
import type { AppHostTypes } from "@polaris/app-host";

export type SessionUser = AppHostTypes["SessionUser"];

export const SECURITY_PERMISSION = "system.manage" as const;

export async function requireSecurityUser(): Promise<SessionUser> {
    return host.session.requirePermission(SECURITY_PERMISSION);
}
