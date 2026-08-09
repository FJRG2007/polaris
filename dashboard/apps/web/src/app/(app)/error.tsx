"use client";

/**
 * Error boundary for the authenticated dashboard. It sits inside the app layout,
 * so a page that throws loses its own panel and keeps the shell, the nav, and
 * every other app reachable. Without it the error reaches Next's global handler,
 * which replaces the entire document with "a client-side exception has occurred"
 * and leaves nothing to click but the back button.
 *
 * Two things this screen has to get right, because the failure it stands in for is
 * already invisible. `reset()` alone re-renders the same subtree against the RSC
 * payload that threw, so a failure on the server side is answered instantly with
 * the identical failure and the button reads as broken - the retry has to ask the
 * server again. And whatever was thrown is shown rather than only logged: nobody
 * reports a crash they were never told the shape of, and the digest alone is a
 * reference to a line in a log the person looking at the screen may not have.
 */

import { useRouter } from "next/navigation";
import { Button, Card, CardBody } from "@polaris/ui";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useState, useTransition } from "react";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
    const router = useRouter();
    const [retrying, startRetry] = useTransition();
    const [attempts, setAttempts] = useState(1);

    useEffect(() => {
        console.error(error);
        setAttempts(countFailure(error));
    }, [error]);

    /** Ask the server for this route again, then re-render the subtree against the
     *  answer. Only `reset()` and the same payload comes back. */
    function retry() {
        startRetry(() => {
            router.refresh();
            reset();
        });
    }

    return (
        <div className="mx-auto flex max-w-lg flex-col gap-4 py-10">
            <Card>
                <CardBody className="flex flex-col gap-4">
                    <div className="flex items-start gap-3">
                        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" />
                        <div className="flex flex-col gap-1">
                            <h1 className="text-sm font-medium">This page stopped working</h1>
                            <p className="text-sm text-muted-foreground">
                                {attempts > 1
                                    ? "It failed the same way again, so trying once more will not clear it. Reload to pick up a new build, or send what is below to whoever is looking at it."
                                    : "The rest of Polaris is still running. Try again, and if Polaris was just updated, reload the page to pick up the new build."}
                            </p>
                        </div>
                    </div>
                    {error.message ? (
                        <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
                            {error.message}
                        </p>
                    ) : null}
                    {error.digest ? (
                        <p className="font-mono text-xs text-muted-foreground">Reference: {error.digest}</p>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => window.location.reload()}>
                            Reload
                        </Button>
                        <Button onClick={retry} disabled={retrying}>
                            <RotateCcw className="size-4" />
                            {retrying ? "Trying" : "Try again"}
                        </Button>
                    </div>
                </CardBody>
            </Card>
        </div>
    );
}

/**
 * How many times in a row this same failure has reached the boundary. A retry that
 * fails mounts a fresh boundary, so the count cannot live in state or a ref; it is
 * module scope, which is per tab and dies with the page. Counting is keyed to the
 * error object so a double-invoked effect in development does not count it twice.
 */
let counted: unknown = null;
let streak = { signature: "", count: 0 };

function countFailure(error: Error & { digest?: string }): number {
    if (counted === error) return streak.count;
    counted = error;
    const signature = error.digest ?? error.message;
    streak = signature === streak.signature ? { signature, count: streak.count + 1 } : { signature, count: 1 };
    return streak.count;
}
