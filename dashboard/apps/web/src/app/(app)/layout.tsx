/**
 * The authenticated group: resolve the session, then draw the frame.
 *
 * The frame itself is AppChrome, a component rather than this layout, because a
 * public profile is outside this group and still has to look like Polaris to
 * somebody who is signed in. What is left here is the one thing that is true of
 * this group and not of that page: reaching any screen under it without a
 * session, or with one that has not cleared its gate, is a redirect.
 */

import type { ReactNode } from "react";
import { requireUser } from "@/lib/session";
import { AppChrome } from "@/components/app-chrome";

export default async function AppLayout({ children }: { children: ReactNode }) {
    const user = await requireUser();
    return <AppChrome user={user}>{children}</AppChrome>;
}
