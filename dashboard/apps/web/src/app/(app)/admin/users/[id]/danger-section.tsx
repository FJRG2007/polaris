"use client";

/** Shutting an account, for a while or for good, and deleting it. */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { banLengthOptions } from "../ban-lengths";
import { Ban, Trash2, Undo2 } from "lucide-react";
import { useAccountAction } from "./use-account-action";
import { useConfirm } from "@/components/confirm-dialog";
import type { DirectoryUser } from "@/lib/user-admin-service";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, Input, Select } from "@polaris/ui";
import { banUserAction, deleteUserAction, unbanUserAction } from "../actions";

export function DangerSection({ user, isSelf }: { user: DirectoryUser; isSelf: boolean }) {
    const t = useTranslations("admin");
    const router = useRouter();
    const format = useDisplayFormat();
    const [confirm, confirmElement] = useConfirm();
    const { busy, error, run } = useAccountAction();
    const [banReason, setBanReason] = useState("");
    /** How long the ban runs for, in minutes. Zero is a ban with no end, which
     *  stays the deliberate choice rather than the default. */
    const [banFor, setBanFor] = useState("1440");

    async function onDelete() {
        const ok = await confirm({
            title: t("users.remove.title", { name: user.name }),
            description: t("users.remove.description"),
            confirmLabel: t("users.remove.confirm"),
            danger: true
        });
        if (!ok) return;
        // The account this page is about is gone, so there is no page left to be
        // on - back to the list rather than a record of nobody.
        if (await run(() => deleteUserAction(user.id))) router.push("/admin/users");
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <h2 className="text-sm font-medium text-danger">
                    {t("usersDetail.account.danger.title")}
                </h2>
                {user.banned ? (
                    <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 text-xs text-muted-foreground">
                            {t("usersDetail.account.danger.status", {
                                kind: user.bannedUntil ? "suspended" : "banned",
                                at: user.bannedAt ? format.dateTime(user.bannedAt) : "",
                                until: user.bannedUntil ? format.dateTime(user.bannedUntil) : "",
                                hasReason: user.banReason ? "yes" : "no",
                                reason: user.banReason ?? ""
                            })}
                        </p>
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void run(() => unbanUserAction(user.id))}
                        >
                            <Undo2 className="size-4" />
                            {t("usersDetail.account.danger.liftBan")}
                        </Button>
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <Input
                                className="flex-1"
                                placeholder={t("usersDetail.account.danger.reasonPlaceholder")}
                                value={banReason}
                                disabled={isSelf}
                                onChange={(event) => setBanReason(event.target.value)}
                            />
                            <Select
                                value={banFor}
                                className="sm:w-44"
                                aria-label={t("users.ban.length")}
                                disabled={isSelf}
                                onValueChange={setBanFor}
                                options={banLengthOptions(t)}
                            />
                            <Button
                                size="sm"
                                variant="danger"
                                disabled={busy || isSelf}
                                onClick={() =>
                                    void run(() =>
                                        banUserAction(user.id, banReason, Number(banFor) || 0)
                                    )
                                }
                            >
                                <Ban className="size-4" />
                                {Number(banFor) > 0 ? t("users.ban.suspend") : t("users.ban.ban")}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {t("usersDetail.account.danger.hint")}
                        </p>
                    </div>
                )}
                <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 text-xs text-muted-foreground">
                        {t("usersDetail.account.danger.deleteHint")}
                    </p>
                    <Button
                        size="sm"
                        variant="danger"
                        disabled={busy || isSelf}
                        onClick={() => void onDelete()}
                    >
                        <Trash2 className="size-4" />
                        {t("usersDetail.account.danger.delete")}
                    </Button>
                </div>
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                {confirmElement}
            </CardBody>
        </Card>
    );
}
