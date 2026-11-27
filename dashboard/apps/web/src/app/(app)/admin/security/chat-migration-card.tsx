"use client";

/**
 * Existing chats moving to sealed (lib/chat/e2ee/legacy-migration.ts): how many
 * conversations are done, what holds the rest, and - for the 30 days a cut
 * conversation keeps its plain copy - a way to put one back as it was.
 * Not shown while sealed chat is off.
 */

import { useState, useTransition } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useDisplayFormat } from "@/components/display-format";
import { Button, Card, CardBody, cn, settingType, useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { MigratedConversation } from "@/lib/chat/e2ee/legacy-migration";
import { migrateChatAgainAction, rollBackChatMigrationAction } from "./chat-migration-actions";

type Progress = { cut: number; remaining: number; failed: number; rolledBack: number; waitingOnBackup: boolean };

export function ChatMigrationCard({ progress, conversations }: { progress: Progress; conversations: MigratedConversation[] }) {
    const t = useTranslations("admin");
    const format = useDisplayFormat();
    const toast = useToast();
    const [confirm, confirmElement] = useConfirm();
    const [rows, setRows] = useState(conversations);
    const [busy, setBusy] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    const label = (row: MigratedConversation) => (row.name ? (row.space ? `${row.space} / ${row.name}` : row.name) : t("security.chatMigration.direct"));

    const rollBack = async (row: MigratedConversation) => {
        const ok = await confirm({
            title: t("security.chatMigration.rollBackTitle"),
            description: t("security.chatMigration.rollBackDescription"),
            confirmLabel: t("security.chatMigration.rollBack"),
            danger: true
        });
        if (!ok) return;
        setBusy(row.channelId);
        startTransition(async () => {
            const outcome = await rollBackChatMigrationAction(row.channelId);
            setBusy(null);
            if ("error" in outcome) return toast.show({ title: outcome.error });
            setRows((all) => all.map((r) => (r.channelId === row.channelId ? { ...r, state: "rolledBack", canRollBack: false } : r)));
            toast.show({ title: t("security.chatMigration.rolledBack", { count: outcome.restored, shown: outcome.restored.toLocaleString() }) });
        });
    };

    const again = (row: MigratedConversation) => {
        setBusy(row.channelId);
        startTransition(async () => {
            const outcome = await migrateChatAgainAction(row.channelId);
            setBusy(null);
            if ("error" in outcome) return toast.show({ title: outcome.error });
            setRows((all) => all.filter((r) => r.channelId !== row.channelId));
            toast.show({ title: t("security.chatMigration.queued") });
        });
    };

    const total = progress.cut + progress.remaining;
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">{t("security.chatMigration.title")}</h2>
                    <p className={settingType.hint}>
                        {t("security.chatMigration.summary", { total, cut: progress.cut.toLocaleString(), shown: total.toLocaleString() })}
                    </p>
                    {progress.waitingOnBackup && progress.remaining > 0 ? (
                        <p className={cn(settingType.small, "text-warning")}>{t("security.chatMigration.waitingOnBackup")}</p>
                    ) : null}
                    {progress.failed > 0 ? (
                        <p className={settingType.error}>{t("security.chatMigration.failed", { count: progress.failed, shown: progress.failed.toLocaleString() })}</p>
                    ) : null}
                </div>
                {rows.length ? (
                    <ul className="flex flex-col divide-y divide-border">
                        {rows.map((row) => (
                            <li key={row.channelId} className="flex items-center gap-3 py-2">
                                <div className="flex min-w-0 flex-1 flex-col">
                                    <span className={cn(settingType.body, "truncate")} title={label(row)}>
                                        {label(row)}
                                    </span>
                                    <span className={cn(settingType.hint, "truncate")}>
                                        {row.state === "cut"
                                            ? t("security.chatMigration.cutAt", { when: row.cutAt ? format.dateTime(row.cutAt) : "" })
                                            : row.state === "failed"
                                              ? t("security.chatMigration.stateFailed")
                                              : t("security.chatMigration.stateRolledBack")}
                                    </span>
                                </div>
                                {row.state === "cut" && row.canRollBack ? (
                                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void rollBack(row)}>
                                        {t("security.chatMigration.rollBack")}
                                    </Button>
                                ) : null}
                                {row.state === "rolledBack" ? (
                                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => again(row)}>
                                        {t("security.chatMigration.migrateAgain")}
                                    </Button>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                ) : null}
            </CardBody>
            {confirmElement}
        </Card>
    );
}
