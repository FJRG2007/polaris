import { redirect } from "next/navigation";
import { homePathForUser, requireUser } from "@/lib/session";

/**
 * The dashboard root sends everybody to their own starting point rather than to
 * a fixed app: the first one their role opens, or their account page when their
 * role opens none. Every "take me home" in Polaris - after signing in, after
 * unlocking, after being turned away from a screen - comes through here, so there
 * is one answer to maintain instead of one per redirect.
 *
 * It lives at the top of the app tree and not in the `(app)` group, and that is
 * the fix for a crash rather than a matter of tidiness. Everything in `(app)` is
 * drawn inside its `loading.tsx`, which is a Suspense boundary: by the time a
 * page there decides to redirect, the frame has already been sent with a 200, so
 * the redirect can only travel inside the stream and be carried out by the
 * browser while it is still hydrating. The React that Next 15 ships breaks on
 * exactly that when anything else talks to the router at the same moment
 * ("Minified React error #310" in the App Router, "Application error" on the
 * screen) - and opening Polaris at its address is the one visit that always
 * goes through here first. Out here nothing has been sent yet, so the redirect
 * is a plain 307 and the browser never renders this address at all.
 */
export default async function DashboardIndex() {
    redirect(await homePathForUser(await requireUser()));
}
