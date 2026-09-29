/**
 * The frame a handed-out page is drawn in, and what it says when there is
 * nothing to draw.
 *
 * A profile is the one address in Polaris that is meant to be opened by both
 * kinds of reader, so it is the one page whose frame is a decision rather than a
 * layout. Somebody signed in gets the application they are already in - the bar,
 * the switcher, the rail, their own account menu - because being handed a link to
 * a colleague should not feel like being logged out. Somebody who is not gets the
 * public bar, which is the same bar with a way in where the account menu would
 * be.
 *
 * Both branches live here rather than in each page so the person's page and the
 * organization's cannot end up in different frames, which is what happened the
 * last time each of them decided for itself.
 */

import type { ReactNode } from "react";
import type { SessionUser } from "@/lib/session";
import { AppChrome } from "@/components/app-chrome";
import { PublicChrome } from "@/components/public-chrome";

export function ProfileFrame({ viewer, children }: { viewer: SessionUser | null; children: ReactNode }) {
    if (!viewer) return <PublicChrome>{children}</PublicChrome>;
    return (
        <AppChrome user={viewer}>
            {/* The same measure as the public column, so the card is the same
                width whoever is reading. Inside the shell it needs the width
                itself - the content area is as wide as the window. */}
            <div className="mx-auto w-full max-w-2xl">{children}</div>
        </AppChrome>
    );
}

/** Kept here for the pages that import it with the frame. */
export { NothingToShow } from "@/components/nothing-to-show";
