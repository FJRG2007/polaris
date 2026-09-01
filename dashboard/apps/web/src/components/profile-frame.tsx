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
import { Card, CardBody } from "@polaris/ui";
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

/**
 * One answer for every reason a page is not being shown.
 *
 * No such account, one that keeps itself out of being found, a block, or a
 * deployment that does not publish profiles at all - telling them apart tells
 * somebody working through a list of handles which it was, and that is the whole
 * value of the list.
 *
 * The single exception is a reader with no session on a deployment that publishes
 * nothing: that is a fact about this Polaris rather than about anybody in it, and
 * leaving it unsaid sends them looking for a spelling mistake that is not there.
 */
export function NothingToShow({ closed, subject }: { closed: boolean; subject: "profile" | "organization" }) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-2 py-10 text-center">
                <p className="text-sm font-medium">Nothing to show here</p>
                <p className="text-muted-foreground mx-auto max-w-md text-sm">
                    {closed
                        ? "This Polaris does not show profiles to people who are not signed in."
                        : subject === "organization"
                          ? "There is no organization at this address."
                          : "There is no profile at this address, or it is not one you can see."}
                </p>
            </CardBody>
        </Card>
    );
}
