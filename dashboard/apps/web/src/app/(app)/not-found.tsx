"use client";

/**
 * The same answer, inside the dashboard.
 *
 * Reached when a screen in here calls `notFound()` - a project id that is not
 * one, a settings section that does not exist, a task somebody no longer has -
 * rather than when the address matched nothing at all. That distinction is worth
 * a second file: the reader is signed in and somewhere, so the shell around them
 * stays, and what they wanted next is almost never the overview. It is the app
 * they were already in, which is one press away in the rail beside this.
 *
 * The root `not-found` handles the other case and cannot do this, because it
 * renders outside this layout on purpose.
 */

import Link from "next/link";
import { Button } from "@polaris/ui";
import { EmptyState } from "@polaris/ui";
import { ArrowLeft, SearchX } from "lucide-react";

export default function AppNotFound() {
    return (
        <EmptyState
            icon={<SearchX />}
            title="This is not here any more"
            description="It may have been removed, renamed, or never existed. Nothing else has changed - everything else is where you left it."
            action={
                <>
                    <Button variant="ghost" onClick={() => window.history.back()}>
                        <ArrowLeft className="size-4 shrink-0" />
                        Back
                    </Button>
                    <Button asChild variant="ghost">
                        <Link href="/home">Overview</Link>
                    </Button>
                </>
            }
        />
    );
}
