"use client";

/**
 * One card that fails to draw stays one card that failed.
 *
 * A screen like a server's Settings is several independent cards - the
 * description, the schedule, the domain, the settings themselves, the reset -
 * and without this a fault in any one of them took the whole page down to
 * "This page stopped working", with nothing left to press and nothing saying
 * which part was at fault. Caught here, the rest of the screen keeps working,
 * and the card that failed says so by name, with the error, so it can be
 * reported as something more useful than a React error number.
 */

import { Button, Card, CardBody } from "@polaris/ui";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

export class CardBoundary extends Component<
    { name: string; children: ReactNode },
    { error: Error | null }
> {
    override state: { error: Error | null } = { error: null };

    static getDerivedStateFromError(error: Error): { error: Error } {
        return { error };
    }

    override componentDidCatch(error: Error, info: ErrorInfo): void {
        // The component stack is the one thing that says where, and it is only
        // readable here: the page-level screen gets the error without it.
        console.error(
            `polaris: the "${this.props.name}" card failed to draw`,
            error,
            info.componentStack
        );
    }

    override render(): ReactNode {
        if (!this.state.error) return this.props.children;
        return (
            <Card>
                <CardBody className="flex flex-col gap-2">
                    <p className="flex items-center gap-2 text-sm font-medium">
                        <TriangleAlert className="size-4 shrink-0 text-danger" aria-hidden />
                        {this.props.name} could not be shown
                    </p>
                    <p className="break-words font-mono text-xs text-muted-foreground">
                        {this.state.error.message || String(this.state.error)}
                    </p>
                    <div>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => this.setState({ error: null })}
                        >
                            <RotateCcw className="size-3.5" /> Try again
                        </Button>
                    </div>
                </CardBody>
            </Card>
        );
    }
}
