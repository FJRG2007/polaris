/**
 * Server-side session and authorization helpers. Every protected page, action,
 * and route resolves the session here and checks permissions server-side - the
 * client capability/role state is only ever cosmetic, so authorization decisions
 * never trust it.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { userHasPermission } from "@polaris/auth";
import type { Permission } from "@polaris/core";
import { auth } from "@/lib/auth";

export interface SessionUser {
    id: string;
    email: string;
    name: string;
    image?: string | null;
    isAdmin: boolean;
}

/** The current session, or null when unauthenticated. */
export async function getSession() {
    return auth.api.getSession({ headers: await headers() });
}

/** Resolve the current user or redirect to sign-in. */
export async function requireUser(): Promise<SessionUser> {
    const session = await getSession();
    if (!session?.user) redirect("/oauth/login");
    const user = session.user as { id: string; email: string; name: string; image?: string | null };
    const isAdmin = (session.user as { isAdmin?: boolean }).isAdmin === true;
    return { id: user.id, email: user.email, name: user.name, image: user.image, isAdmin };
}

/** Require a specific permission; redirect to the drive with a denial flag if missing. */
export async function requirePermission(permission: Permission): Promise<SessionUser> {
    const user = await requireUser();
    if (user.isAdmin) return user;
    if (!(await userHasPermission(user.id, permission))) redirect("/drive?denied=1");
    return user;
}

/** Require the admin flag (the second gate for operator-only surfaces). */
export async function requireAdmin(): Promise<SessionUser> {
    const user = await requireUser();
    if (!user.isAdmin) redirect("/drive?denied=1");
    return user;
}
