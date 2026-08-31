"use client";

/**
 * The page for an address with nothing behind it.
 *
 * Next serves this for every URL the app does not match, so it is what a
 * mistyped link, a stale bookmark and a bug in one of our own links all arrive
 * at. Until now that was the framework's own black-and-white page: no way back,
 * nothing that looked like Polaris, and nothing a person could put in a report
 * beyond "it said 404".
 *
 * It renders in the root layout rather than the dashboard's, because an
 * unmatched address has no session behind it and may be a signed-out visitor on
 * a public link. So it stands on its own and offers the way in rather than
 * assuming a sidebar is there.
 *
 * The address is shown deliberately. When the broken link is one of ours - and
 * the reason this page exists at all is that one of them was - the path is the
 * whole bug report, and asking somebody to read it out of their URL bar is
 * asking them to do the work of finding it.
 */

import Link from "next/link";
import { Button } from "@polaris/ui";
import { usePathname } from "next/navigation";
import { ArrowLeft, Compass } from "lucide-react";

export default function NotFound() {
    const pathname = usePathname();

    return (
        <main className="flex min-h-screen items-center justify-center p-6">
            <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-surface p-6">
                <div className="flex flex-col gap-1">
                    <p className="font-mono text-xs text-muted-foreground">404</p>
                    <h1 className="text-sm font-medium">There is nothing at this address</h1>
                    <p className="text-sm text-muted-foreground">
                        The link may be out of date, or the thing it pointed at may have been removed.
                    </p>
                </div>

                {pathname ? (
                    <p className="overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
                        {pathname}
                    </p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                    <Button asChild>
                        <Link href="/home">
                            <Compass className="size-4 shrink-0" />
                            Go to the overview
                        </Link>
                    </Button>
                    {/* history.back() rather than a router call: the page before
                        this one may not be a page of ours at all. */}
                    <Button variant="ghost" onClick={() => window.history.back()}>
                        <ArrowLeft className="size-4 shrink-0" />
                        Back
                    </Button>
                </div>
            </div>
        </main>
    );
}
