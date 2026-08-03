"use client";

/**
 * The row shape every security control shares: what it is, whether it is on, and
 * the buttons that open its dialog. Keeping the chrome here lets each control's
 * own file be nothing but its dialog and the call to the server.
 */

import type { ReactNode } from "react";
import { Badge, Card, CardBody } from "@polaris/ui";

export function SettingCard({
    title,
    description,
    status,
    statusTone = "off",
    children
}: {
    title: string;
    description: string;
    status?: string;
    statusTone?: "on" | "off";
    children?: ReactNode;
}) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <h2 className="text-sm font-medium">{title}</h2>
                        {status ? (
                            <Badge variant={statusTone === "on" ? "success" : "neutral"}>{status}</Badge>
                        ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">{description}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
            </CardBody>
        </Card>
    );
}

/**
 * A control the account has, held shut for a reason the person can read.
 *
 * Passed down rather than each card working it out, so one rule decides what is
 * locked. Undefined is the ordinary case and reads as "not locked" everywhere it
 * is checked, which keeps every call site to a single truthiness test.
 *
 * The server refuses these actions regardless; this exists so the screen says why
 * before somebody fills in a dialog that was never going to be accepted.
 */
export interface SettingLock {
    reason: string;
}

/** Inline feedback under a dialog's fields. */
export function Feedback({ error, ok }: { error?: string | null; ok?: string | null }) {
    if (error) return <p className="text-sm text-danger">{error}</p>;
    if (ok) return <p className="text-sm text-success">{ok}</p>;
    return null;
}
