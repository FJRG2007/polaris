"use client";

/**
 * The changes made on this device that Polaris has not taken yet, above the
 * grid: a clock while each waits, and for one that was not made, why, with
 * Try again and Drop - and, for a save refused because the event changed
 * meanwhile, Keep mine.
 */

import { Button } from "@polaris/ui";
import { useCalendarT } from "./i18n";
import { AlertCircle, Clock } from "lucide-react";
import { dropKept, overwriteArgs, retryKept, type KeptCall, type KeptMeta } from "./offline-calls";

function describe(meta: unknown, t: ReturnType<typeof useCalendarT>, untitled: string): string {
    const kept = meta as Partial<KeptMeta> | null;
    const title = kept?.summary || untitled;
    if (kept?.op === "delete") return t("offline.delete", { title });
    if (kept?.op === "shift") return t("offline.move", { title });
    if (kept?.op === "save" && kept.objectId === null) return t("offline.create", { title });
    return t("offline.save", { title });
}

export function KeptStrip({ kept }: { kept: readonly KeptCall[] }) {
    const t = useCalendarT();
    if (kept.length === 0) return null;
    return (
        <section aria-label={t("offline.title")} className="flex flex-col border-b border-border">
            <ul className="flex max-h-32 flex-col overflow-y-auto">
                {kept.map((call) => {
                    const failed = call.state === "failed";
                    const label = describe(call.meta, t, t("screen.untitled"));
                    const reason = call.reason || t("offline.notMade");
                    const overwrite = failed ? overwriteArgs(call) : null;
                    return (
                        <li key={call.key} className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm">
                            {failed ? (
                                <AlertCircle className="size-4 shrink-0 text-danger" aria-hidden />
                            ) : (
                                <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                            )}
                            <span className="min-w-0 flex-1 truncate" title={label}>
                                {label}
                            </span>
                            <span
                                className={
                                    failed
                                        ? "min-w-0 max-w-[40%] truncate text-xs text-danger"
                                        : "shrink-0 text-xs text-muted-foreground"
                                }
                                title={failed ? reason : undefined}
                            >
                                {failed ? reason : t("offline.waiting")}
                            </span>
                            {overwrite ? (
                                <Button size="xs" variant="ghost" onClick={() => retryKept(call, overwrite)}>
                                    {t("offline.keepMine")}
                                </Button>
                            ) : null}
                            {failed ? (
                                <Button size="xs" variant="ghost" onClick={() => retryKept(call)}>
                                    {t("screen.retry")}
                                </Button>
                            ) : null}
                            {failed ? (
                                <Button size="xs" variant="ghost" onClick={() => dropKept(call)}>
                                    {t("offline.drop")}
                                </Button>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
