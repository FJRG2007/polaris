"use client";

/**
 * Drive changes made while Polaris could not be reached, above the folder:
 * each with a clock until it is made, or with why it was not made and Try
 * again. Any of them can be dropped - nothing on the source has changed yet.
 */

import { AlertCircle, Clock } from "lucide-react";
import { Button } from "@polaris/ui";
import type { AppWrite } from "@/lib/offline/app-writes";
import { appWrites } from "@/lib/offline/app-writes";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { DriveChange } from "./offline-changes";

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function KeptDriveChanges({ changes }: { changes: readonly AppWrite[] }) {
    const t = useTranslations("drive");
    if (changes.length === 0) return null;

    const describe = (change: DriveChange): string => {
        switch (change.op) {
            case "rename":
                return t("offline.rename", { from: nameOf(change.from), to: nameOf(change.to) });
            case "move":
                return change.dest
                    ? t("offline.move", { name: nameOf(change.from), folder: nameOf(change.dest) })
                    : t("offline.moveTop", { name: nameOf(change.from) });
            case "trash":
                return t("offline.trash", { name: nameOf(change.path) });
            case "mkdir":
                return t("offline.mkdir", { name: change.name });
        }
    };

    return (
        <section aria-label={t("offline.title")} className="flex flex-col border-b border-border">
            <ul className="flex flex-col">
                {changes.map((entry) => {
                    const failed = entry.state === "failed";
                    const label = describe(entry.payload as DriveChange);
                    return (
                        <li key={entry.key} className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm">
                            {failed ? (
                                <AlertCircle className="size-4 shrink-0 text-danger" aria-hidden />
                            ) : (
                                <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                            )}
                            <span className="min-w-0 flex-1 truncate" title={label}>
                                {label}
                            </span>
                            <span
                                className={failed ? "min-w-0 max-w-[40%] truncate text-xs text-danger" : "shrink-0 text-xs text-muted-foreground"}
                                title={failed ? entry.reason || t("offline.notMade") : undefined}
                            >
                                {failed ? entry.reason || t("offline.notMade") : t("offline.waiting")}
                            </span>
                            {failed ? (
                                <Button size="xs" variant="ghost" onClick={() => void appWrites.retry(entry)}>
                                    {t("offline.retry")}
                                </Button>
                            ) : null}
                            <Button size="xs" variant="ghost" onClick={() => void appWrites.discard(entry.key)}>
                                {t("offline.drop")}
                            </Button>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
