"use client";

/**
 * Error boundary for the authenticated dashboard. It sits inside the app layout,
 * so a page that throws loses its own panel and keeps the shell, the nav, and
 * every other app reachable. Without it the error reaches Next's global handler,
 * which replaces the entire document with "a client-side exception has occurred"
 * and leaves nothing to click but the back button.
 */

import { useEffect } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button, Card, CardBody } from "@polaris/ui";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
    useEffect(() => {
        console.error(error);
    }, [error]);

    return (
        <div className="mx-auto flex max-w-lg flex-col gap-4 py-10">
            <Card>
                <CardBody className="flex flex-col gap-4">
                    <div className="flex items-start gap-3">
                        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" />
                        <div className="flex flex-col gap-1">
                            <h1 className="text-sm font-medium">This page stopped working</h1>
                            <p className="text-sm text-muted-foreground">
                                The rest of Polaris is still running. Try again, and if Polaris was just updated,
                                reload the page to pick up the new build.
                            </p>
                        </div>
                    </div>
                    {error.digest ? (
                        <p className="font-mono text-xs text-muted-foreground">Reference: {error.digest}</p>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => window.location.reload()}>
                            Reload
                        </Button>
                        <Button onClick={reset}>
                            <RotateCcw className="size-4" />
                            Try again
                        </Button>
                    </div>
                </CardBody>
            </Card>
        </div>
    );
}
