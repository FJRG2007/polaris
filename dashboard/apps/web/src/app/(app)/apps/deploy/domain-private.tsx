"use client";

/**
 * One address made private: visitors sign in to Polaris and only the project's
 * members, or the people, groups and roles named here, get through. The list editor
 * is the firewall's own, so naming who gets in reads the same everywhere.
 */

import { useState, useTransition } from "react";
import { setDomainPrivateAction } from "./actions";
import { Loader2, Lock, LockOpen } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { LoginPrincipals } from "@/app/(app)/apps/firewall/login-principals";
import { privateAccessSchema, type PrivateAccess } from "@/lib/deploy/private-domain";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Switch,
    cn
} from "@polaris/ui";

const DEFAULT_ACCESS: PrivateAccess = { members: true, allow: [], deny: [] };

export function DomainPrivateButton({
    domainId,
    applicationId,
    hostname,
    access,
    canManage,
    onChanged
}: {
    domainId: string;
    applicationId: string;
    hostname: string;
    access: PrivateAccess | null;
    canManage: boolean;
    onChanged: () => void;
}) {
    const t = useTranslations("deployService");
    const [open, setOpen] = useState(false);
    const [enabled, setEnabled] = useState(access !== null);
    const [draft, setDraft] = useState<PrivateAccess>(access ?? DEFAULT_ACCESS);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [pending, startTransition] = useTransition();
    const valid = !enabled || privateAccessSchema.safeParse(draft).success;
    const dirty =
        enabled !== (access !== null) ||
        (enabled && JSON.stringify(draft) !== JSON.stringify(access ?? DEFAULT_ACCESS));

    function show(next: boolean) {
        if (next) {
            setEnabled(access !== null);
            setDraft(access ?? DEFAULT_ACCESS);
            setError(null);
            setSaved(false);
        }
        setOpen(next);
    }

    function save() {
        setError(null);
        setSaved(false);
        startTransition(async () => {
            const result = await setDomainPrivateAction({
                domainId,
                access: enabled ? draft : null
            });
            if (result.error) setError(result.error);
            else {
                setSaved(true);
                onChanged();
            }
        });
    }

    const label = access ? t("private.open") : t("private.public");
    return (
        <>
            <button
                type="button"
                title={canManage ? label : `${label}. ${t("private.noManage")}`}
                aria-label={label}
                onClick={() => show(true)}
                className={cn(
                    "shrink-0 rounded p-0.5 transition-colors hover:text-foreground",
                    access ? "text-primary" : "text-muted-foreground"
                )}
            >
                {access ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
            </button>
            <Dialog open={open} onOpenChange={show}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>{t("private.title")}</DialogTitle>
                        <DialogDescription className="break-words">
                            {t("private.description", { hostname })}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex min-w-0 flex-col gap-4">
                        {!canManage ? (
                            <p className="text-xs text-muted-foreground">{t("private.noManage")}</p>
                        ) : null}
                        <label className="flex items-center gap-2 text-sm">
                            <Switch
                                checked={enabled}
                                disabled={pending || !canManage}
                                onChange={setEnabled}
                                aria-label={t("private.toggle")}
                            />
                            {t("private.toggle")}
                        </label>
                        {enabled ? (
                            <div className="flex min-w-0 flex-col gap-3">
                                <label className="flex items-start gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        className="mt-0.5"
                                        checked={draft.members}
                                        disabled={pending || !canManage}
                                        onChange={(event) =>
                                            setDraft({ ...draft, members: event.target.checked })
                                        }
                                    />
                                    <span className="min-w-0">
                                        {t("private.members")}
                                        <span className="block text-xs text-muted-foreground">
                                            {t("private.membersHint")}
                                        </span>
                                    </span>
                                </label>
                                <div className="flex min-w-0 flex-col gap-1.5">
                                    <p className="text-sm">{t("private.named")}</p>
                                    <LoginPrincipals
                                        scope={{ scopeType: "application", scopeId: applicationId }}
                                        admitted={draft.allow}
                                        refused={draft.deny}
                                        disabled={pending || !canManage}
                                        copy={{
                                            admittedEmpty: t("private.namedEmpty"),
                                            admittedFilled: t("private.namedFilled")
                                        }}
                                        onChange={(patch) =>
                                            setDraft({
                                                ...draft,
                                                allow: patch.loginAllowPrincipals ?? draft.allow,
                                                deny: patch.loginDenyPrincipals ?? draft.deny
                                            })
                                        }
                                    />
                                </div>
                                {!valid ? (
                                    <p className="text-xs text-warning">{t("private.needsAudience")}</p>
                                ) : null}
                            </div>
                        ) : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        {saved && !dirty ? (
                            <p className="text-sm text-success">{t("private.saved")}</p>
                        ) : null}
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => show(false)}>
                            {t("private.close")}
                        </Button>
                        <Button
                            disabled={pending || !canManage || !valid || !dirty}
                            onClick={save}
                        >
                            {pending ? <Loader2 className="size-4 animate-spin" /> : null}{" "}
                            {t("private.save")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
