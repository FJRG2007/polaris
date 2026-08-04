"use client";

/**
 * Every code this account has answered.
 *
 * Scanning one signs a device in as you, and until this list existed the only
 * trace was a line in the log and a session that looks like any other. So each
 * answer is shown as what it decided: which browser was let in or turned away,
 * where it was asking from, and - the part the log could not say on its own -
 * which of your devices read the code.
 *
 * Refusals are kept, not hidden. A code somebody else put in front of you is
 * refused once and matters more than the twenty you allowed.
 */

import { Check, ScanLine, X } from "lucide-react";
import { Badge, Card, CardBody } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import type { QrSignInAnswer } from "@/lib/qr-sign-in-service";

export function ScanHistory({ answers }: { answers: readonly QrSignInAnswer[] }) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">Codes you have answered</h2>
                    <p className="text-xs text-muted-foreground">
                        Each one signed a device in as you, or turned it away.
                    </p>
                </div>

                {answers.length === 0 ? (
                    <p className="py-4 text-center text-xs text-muted-foreground">
                        You have not answered a sign-in code yet.
                    </p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {answers.map((answer) => (
                            <li
                                key={answer.id}
                                className="flex items-start gap-3 rounded-md border border-border p-3"
                            >
                                {answer.allowed ? (
                                    <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                                ) : (
                                    <X className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                                )}
                                <div className="min-w-0 flex-1">
                                    <p className="flex flex-wrap items-center gap-1.5 text-sm">
                                        <span className="min-w-0 truncate">{answer.device}</span>
                                        <Badge variant={answer.allowed ? "success" : "neutral"}>
                                            {answer.allowed ? "Signed in" : "Refused"}
                                        </Badge>
                                    </p>
                                    {answer.origin || answer.host ? (
                                        <p className="truncate text-xs text-muted-foreground">
                                            {[answer.origin, answer.host].filter(Boolean).join(" - ")}
                                        </p>
                                    ) : null}
                                    {/* The other half of the answer: not what was let
                                        in, but which of your devices let it. */}
                                    <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                                        <ScanLine className="size-3 shrink-0" aria-hidden />
                                        {answer.scannedOn ? (
                                            <span className="min-w-0 truncate">
                                                Read on {answer.scannedOn}
                                            </span>
                                        ) : (
                                            <span>Read on a device that is no longer signed in</span>
                                        )}
                                        {answer.here ? <Badge variant="neutral">This device</Badge> : null}
                                    </p>
                                </div>
                                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                                    <RelativeTime iso={answer.at} />
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </CardBody>
        </Card>
    );
}
