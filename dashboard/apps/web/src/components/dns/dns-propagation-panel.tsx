"use client";

/**
 * What each public resolver answers for a record, opened under its row in the
 * records table. See `PropagationPanel`.
 */

import { Badge, Button } from "@polaris/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDisplayFormat } from "@/components/display-format";
import type { PropagationReport } from "@/lib/dns/propagation";
import { dnsPropagationAction, type DnsScopeRef } from "@/app/(app)/account/domains/dns-actions";
import {
    AlertTriangle,
    CheckCircle2,
    CircleSlash,
    Loader2,
    RefreshCw,
    XCircle
} from "lucide-react";

/** How long a record that has not settled waits between checks, and how many
 *  checks it gets before it stops asking on its own. */
const PROPAGATION_SECONDS = 15;
const PROPAGATION_ATTEMPTS = 40;

/**
 * What each public resolver answers for a record, against what the zone holds.
 * Checks again on its own until they all agree, so a change can be watched
 * arriving instead of being refreshed for.
 */
export function PropagationPanel({ scope, recordId }: { scope: DnsScopeRef; recordId: string }) {
    const format = useDisplayFormat();
    const [report, setReport] = useState<PropagationReport | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [attempts, setAttempts] = useState(0);
    const [left, setLeft] = useState(PROPAGATION_SECONDS);
    const scopeRef = useRef(scope);
    scopeRef.current = scope;

    const check = useCallback(async () => {
        setBusy(true);
        const result = await dnsPropagationAction(scopeRef.current, recordId).catch(() => ({
            error: "Could not ask the resolvers",
            report: undefined
        }));
        setBusy(false);
        setAttempts((count) => count + 1);
        if (result.report) {
            setReport(result.report);
            setError("");
        } else setError(result.error ?? "Could not ask the resolvers");
    }, [recordId]);

    useEffect(() => {
        void check();
    }, [check]);

    const waiting = !busy && report !== null && !report.settled && attempts < PROPAGATION_ATTEMPTS;
    useEffect(() => {
        if (!waiting) return;
        let remaining = PROPAGATION_SECONDS;
        setLeft(remaining);
        const timer = window.setInterval(() => {
            if (document.visibilityState === "hidden") return;
            remaining -= 1;
            setLeft(remaining);
            if (remaining <= 0) {
                window.clearInterval(timer);
                void check();
            }
        }, 1000);
        return () => window.clearInterval(timer);
    }, [waiting, check]);

    return (
        <div className="flex flex-col gap-2" aria-live="polite">
            <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">Propagation</span>
                {report?.settled ? (
                    <Badge variant="success">Every resolver agrees</Badge>
                ) : report ? (
                    <Badge variant="warning">Not everywhere yet</Badge>
                ) : null}
                <span className="text-muted-foreground">
                    {busy
                        ? "Asking the resolvers..."
                        : waiting
                          ? `Checking again in ${left}s.`
                          : report
                            ? `Checked ${format.time(report.checkedAt)}.`
                            : ""}
                </span>
                <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    disabled={busy}
                    onClick={() => void check()}
                >
                    {busy ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <RefreshCw className="size-4" />
                    )}{" "}
                    Check now
                </Button>
            </div>
            {error && <p className="text-danger text-xs">{error}</p>}
            {report && report.expected === null && (
                <p className="text-muted-foreground text-xs">
                    Proxied through Cloudflare, so resolvers answer with Cloudflare&rsquo;s
                    addresses rather than the value here. Compared with each other instead.
                </p>
            )}
            {report && (
                <ul className="flex flex-col gap-1">
                    {report.resolvers.map((resolver) => (
                        <li
                            key={resolver.resolver}
                            className="flex flex-wrap items-start gap-2 text-xs"
                        >
                            {resolver.agrees === true ? (
                                <CheckCircle2 className="text-success mt-px size-3.5 shrink-0" />
                            ) : resolver.agrees === false ? (
                                <XCircle className="text-warning mt-px size-3.5 shrink-0" />
                            ) : (
                                <CircleSlash className="text-foreground-subtle mt-px size-3.5 shrink-0" />
                            )}
                            <span className="w-40 shrink-0">{resolver.label}</span>
                            <code className="text-muted-foreground min-w-0 flex-1 break-all">
                                {resolver.status === "unreachable"
                                    ? "Did not answer"
                                    : resolver.status === "missing"
                                      ? "No such name yet"
                                      : resolver.values.length > 0
                                        ? resolver.values.join(", ")
                                        : "No record of this type yet"}
                            </code>
                        </li>
                    ))}
                </ul>
            )}
            {!busy && report && !report.settled && attempts >= PROPAGATION_ATTEMPTS && (
                <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
                    <AlertTriangle className="mt-px size-3.5 shrink-0" />
                    Stopped checking on its own. A resolver keeps an old answer until its cached
                    copy expires, which can take as long as the old record&rsquo;s TTL.
                </p>
            )}
        </div>
    );
}
