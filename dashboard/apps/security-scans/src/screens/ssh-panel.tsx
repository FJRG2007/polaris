"use client";

/**
 * SSH sign-in on one server: whether it still takes passwords, in a line, and
 * the review that lists who keeps signing in with a key and who stops before
 * password sign-in is turned off.
 */

import { useEffect, useState } from "react";
import { ErrorLine } from "./error-line";
import * as actions from "../actions/security";
import type { SecurityTranslator } from "../lib/i18n";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Skeleton
} from "@polaris/ui";

type Submit = (
    work: () => Promise<{ ok: boolean; error?: string }>,
    done?: string
) => Promise<void>;

type View = Extract<Awaited<ReturnType<typeof actions.sshAction>>, { ok: true }>["data"];

export interface SshSummary {
    readonly ssh: string;
    readonly sshHardened: boolean | null;
    readonly sshBlocked: string | null;
    readonly sshOffByHandAt: string | null;
}

function hintOf(t: SecurityTranslator, summary: SshSummary): string {
    if (summary.ssh === "on") return t("ssh.hint.on");
    if (summary.ssh === "armed") return t("ssh.hint.armed");
    if (summary.ssh === "unavailable") return t("ssh.hint.unavailable");
    if (summary.ssh !== "off") return t("ssh.hint.unknown");
    if (summary.sshHardened) return t("ssh.hint.already");
    if (summary.sshOffByHandAt) {
        return t("ssh.hint.offByHand", { when: new Date(summary.sshOffByHandAt).toLocaleString() });
    }
    if (summary.sshBlocked === "passwordLogin") return t("ssh.hint.polarisPassword");
    if (summary.sshBlocked === "noKeys") return t("ssh.hint.noKeys");
    return t("ssh.hint.off");
}

export function SshPanel({
    t,
    targetId,
    summary,
    submit,
    review = false
}: {
    t: SecurityTranslator;
    targetId: string;
    summary: SshSummary;
    submit: Submit;
    /** Opened from an alert about this: the review starts open. */
    review?: boolean;
}) {
    const [shown, setShown] = useState(summary);
    const [reviewing, setReviewing] = useState(review);
    const [busy, setBusy] = useState(false);
    useEffect(() => setShown(summary), [summary]);
    const turnOff = async () => {
        const previous = shown;
        setBusy(true);
        setShown({ ...shown, ssh: "off", sshHardened: false, sshOffByHandAt: new Date().toISOString() });
        await submit(async () => {
            const result = await actions.sshOffAction({ targetId });
            if (!result.ok) setShown(previous);
            return result;
        }, t("ssh.offDone"));
        setBusy(false);
    };
    const keyOnly = shown.ssh === "on" || (shown.ssh === "off" && shown.sshHardened === true);
    const canReview = shown.ssh === "off" && !shown.sshHardened;
    return (
        <div className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                    <span className="flex items-center gap-2 font-medium">
                        {t("ssh.title")}
                        {keyOnly ? <Badge variant="success">{t("ssh.on")}</Badge> : null}
                    </span>
                    <span className="text-muted-foreground">{hintOf(t, shown)}</span>
                </span>
                <span className="flex shrink-0 flex-wrap gap-2">
                    {shown.ssh === "on" ? (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void turnOff()}>
                            {t("ssh.turnOff")}
                        </Button>
                    ) : null}
                    {canReview ? (
                        <Button size="sm" disabled={busy} onClick={() => setReviewing(true)}>
                            {t("ssh.turnOn")}
                        </Button>
                    ) : null}
                </span>
            </div>
            {reviewing ? (
                <ReviewDialog
                    t={t}
                    targetId={targetId}
                    onClose={() => setReviewing(false)}
                    onApplied={(view) =>
                        setShown({
                            ssh: view.state,
                            sshHardened: view.plan.hardened,
                            sshBlocked: view.plan.blocked,
                            sshOffByHandAt: null
                        })
                    }
                    submit={submit}
                />
            ) : null}
        </div>
    );
}

function Names({ names }: { names: readonly string[] }) {
    return (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {names.map((name) => (
                <li key={name} className="truncate font-mono" title={name}>
                    {name}
                </li>
            ))}
        </ul>
    );
}

/** The keys that keep signing in, by account, with Polaris's own named. */
export function KeyList({ t, keys }: { t: SecurityTranslator; keys: View["keys"] }) {
    return (
        <ul className="flex max-h-56 flex-col gap-2 overflow-y-auto">
            {keys.map((key) => (
                <li key={`${key.account} ${key.fingerprint}`} className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono" title={key.account}>
                            {key.account}
                        </span>
                        <span className="shrink-0 text-muted-foreground">{key.type}</span>
                        {key.polaris ? (
                            <Badge className="shrink-0" variant="neutral">
                                {t("ssh.polarisKey")}
                            </Badge>
                        ) : null}
                    </div>
                    <span
                        className="truncate text-xs text-muted-foreground"
                        title={`${key.comment} ${key.fingerprint}`.trim()}
                    >
                        {key.polaris ? t("ssh.polarisKeyHint") : key.comment || t("ssh.noComment")}
                        {" · "}
                        <span className="font-mono">{key.fingerprint}</span>
                    </span>
                </li>
            ))}
        </ul>
    );
}

function ReviewDialog({
    t,
    targetId,
    onClose,
    onApplied,
    submit
}: {
    t: SecurityTranslator;
    targetId: string;
    onClose: () => void;
    onApplied: (view: View) => void;
    submit: Submit;
}) {
    const [view, setView] = useState<View | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [applying, setApplying] = useState(false);
    useEffect(() => {
        let live = true;
        void actions.sshAction({ targetId }).then((result) => {
            if (!live) return;
            if (!result.ok) {
                setFailure(result.error);
                return;
            }
            setView(result.data);
        });
        return () => {
            live = false;
        };
    }, [targetId, t]);
    const apply = async () => {
        setApplying(true);
        await submit(async () => {
            const result = await actions.applySshAction({ targetId });
            if (result.ok) {
                onApplied(result.data);
                onClose();
            }
            return result;
        }, t("ssh.done"));
        setApplying(false);
    };
    const blocked = view?.plan.blocked ?? null;
    return (
        <Dialog open onOpenChange={(next) => !next && !applying && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("ssh.dialogTitle")}</DialogTitle>
                    <DialogDescription>{t("ssh.dialogHint")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-4 text-sm">
                    {failure ? <ErrorLine t={t} code={failure} /> : null}
                    {!view && !failure ? <Skeleton className="h-32 w-full" /> : null}
                    {blocked ? <p className="text-warning">{t(`ssh.blocked.${blocked}`)}</p> : null}
                    {view ? (
                        <section className="flex flex-col gap-2">
                            <h3 className="font-medium">{t("ssh.keeps")}</h3>
                            {view.plan.keyed.length === 0 ? (
                                <p className="text-muted-foreground">{t("ssh.keepsNone")}</p>
                            ) : view.keys.length > 0 ? (
                                <KeyList t={t} keys={view.keys} />
                            ) : (
                                <Names names={view.plan.keyed} />
                            )}
                        </section>
                    ) : null}
                    {view && view.plan.loses.length > 0 ? (
                        <section className="flex flex-col gap-2">
                            <h3 className="font-medium">{t("ssh.loses")}</h3>
                            <p className="text-muted-foreground">{t("ssh.losesHint")}</p>
                            <Names names={view.plan.loses} />
                        </section>
                    ) : null}
                    {applying ? <p className="text-muted-foreground">{t("ssh.applying")}</p> : null}
                </div>
                <DialogFooter>
                    <Button variant="ghost" disabled={applying} onClick={onClose}>
                        {t("ssh.cancel")}
                    </Button>
                    <Button disabled={!view || applying || blocked !== null} onClick={() => void apply()}>
                        {t("ssh.turnOn")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
