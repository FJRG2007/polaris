"use client";

/**
 * Last-resort boundary, for a failure in the root layout itself. It replaces the
 * root layout when it renders, so it brings its own document and stylesheets.
 * Only reached when the per-segment boundaries cannot be mounted; everything else
 * is caught closer to where it happened.
 */

import "./globals.css";
import "@polaris/ui/styles.css";
import { useEffect } from "react";
import { isStaleBuildError, reloadForNewBuild } from "@/lib/stale-build";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
    const staleBuild = isStaleBuildError(error);

    useEffect(() => {
        console.error(error);
    }, [error]);

    // A tab that outlived a deploy is holding chunks the server no longer serves.
    // Recovered the same way here as in the dashboard's own boundary: once, and
    // then this screen is shown rather than looping.
    useEffect(() => {
        if (staleBuild) reloadForNewBuild();
    }, [staleBuild]);

    return (
        <html lang="en" suppressHydrationWarning>
            <body>
                <div className="flex min-h-screen items-center justify-center p-6">
                    <div className="flex max-w-md flex-col gap-4 rounded-lg border border-border bg-surface p-6">
                        <div className="flex flex-col gap-1">
                            <h1 className="text-sm font-medium">
                                {staleBuild ? "Polaris was updated while this page was open" : "Polaris could not start this page"}
                            </h1>
                            <p className="text-sm text-muted-foreground">
                                {staleBuild
                                    ? "This tab is still running the old build. Reload to pick up the new one."
                                    : "Reload to try again. If it keeps happening, this is what it failed with."}
                            </p>
                        </div>
                        {error.message && !staleBuild ? (
                            <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
                                {error.message}
                            </p>
                        ) : null}
                        {error.digest && !staleBuild ? (
                            <p className="font-mono text-xs text-muted-foreground">Reference: {error.digest}</p>
                        ) : null}
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => window.location.reload()}
                                className="w-fit rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                            >
                                Reload
                            </button>
                            {/* Retrying an old build only reproduces the failure. */}
                            {!staleBuild && (
                                <button
                                    type="button"
                                    onClick={reset}
                                    className="w-fit rounded-md px-4 py-2 text-sm font-medium hover:bg-muted"
                                >
                                    Try again
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </body>
        </html>
    );
}
