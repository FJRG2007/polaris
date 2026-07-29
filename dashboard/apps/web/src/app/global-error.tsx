"use client";

/**
 * Last-resort boundary, for a failure in the root layout itself. It replaces the
 * root layout when it renders, so it brings its own document and stylesheets.
 * Only reached when the per-segment boundaries cannot be mounted; everything else
 * is caught closer to where it happened.
 */

import "@polaris/ui/styles.css";
import "./globals.css";
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
    useEffect(() => {
        console.error(error);
    }, [error]);

    return (
        <html lang="en" suppressHydrationWarning>
            <body>
                <div className="flex min-h-screen items-center justify-center p-6">
                    <div className="flex max-w-md flex-col gap-4 rounded-lg border border-border bg-surface p-6">
                        <div className="flex flex-col gap-1">
                            <h1 className="text-sm font-medium">Polaris could not start this page</h1>
                            <p className="text-sm text-muted-foreground">
                                Reload to try again. If it keeps happening, the server logs have the details.
                            </p>
                        </div>
                        {error.digest ? (
                            <p className="font-mono text-xs text-muted-foreground">Reference: {error.digest}</p>
                        ) : null}
                        <button
                            type="button"
                            onClick={reset}
                            className="w-fit rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                        >
                            Try again
                        </button>
                    </div>
                </div>
            </body>
        </html>
    );
}
