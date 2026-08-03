import { redirect } from "next/navigation";
import { homePathForUser, requireUser } from "@/lib/session";

/**
 * The dashboard root sends everybody to their own starting point rather than to
 * a fixed app: the first one their role opens, or their account page when their
 * role opens none. Every "take me home" in Polaris - after signing in, after
 * unlocking, after being turned away from a screen - comes through here, so there
 * is one answer to maintain instead of one per redirect.
 */
export default async function DashboardIndex() {
    redirect(await homePathForUser(await requireUser()));
}
