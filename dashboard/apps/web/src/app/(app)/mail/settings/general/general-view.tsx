"use client";

/**
 * The four things Polaris used to decide for everybody.
 *
 * Written as questions somebody can answer without knowing what the setting is
 * called: not "auto-advance", but what should happen after you file one. Each is
 * a real behaviour that existed before this screen did, with the old constant as
 * its default - so nothing changes for anybody who never opens this.
 *
 * The reading layout sits here too, and says out loud that it is remembered for
 * this browser rather than for the account. It is the one thing on the screen
 * that is genuinely about a device: a phone and a desk are not the same shape,
 * and choosing on one must not reshape the other. Somebody looking for where
 * that lives looks here, which is why it is drawn here even though it is stored
 * somewhere else.
 */

import * as core from "@polaris/core";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { Button, Select, useToast } from "@polaris/ui";
import { useMailLayout } from "@/app/(app)/mail/use-mail-layout";
import { setMailPreferencesAction } from "@/app/(app)/mail/actions";
import { useEffect, useState, type ReactNode } from "react";
import { useBusy } from "@/app/(app)/mail/use-busy";
import { mailOptionLabel } from "@/app/(app)/mail/option-label";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function GeneralView({ preferences }: { preferences: core.MailPreferences }) {
    const toast = useToast();
    const t = useTranslations("mailSettings");
    const tm = useTranslations("mail");
    const tc = useTranslations("common");
    const [saving, startSaving] = useBusy();
    const [held, setHeld] = useState<core.MailPreferences>(preferences);
    const [layout, chooseLayout] = useMailLayout();

    /** Whether anything on the form differs from what is stored. A Save that is
     *  always pressable is a Save nobody can tell they have used. */
    const changed =
        held.sort !== preferences.sort ||
        held.markRead !== preferences.markRead ||
        held.afterFiling !== preferences.afterFiling ||
        held.undoSeconds !== preferences.undoSeconds ||
        held.mailboxes !== preferences.mailboxes;

    function save(): void {
        startSaving(async () => {
            const answer = await setMailPreferencesAction(held);
            const said = refusalOf(answer);
            toast.show({ title: said ?? t("general.saved") });
        });
    }

    return (
        <div className="space-y-5">
            <Field
                label={t("general.mailboxes")}
                hint={t("general.mailboxesHint")}
            >
                <Select
                    aria-label={t("general.mailboxes")}
                    value={held.mailboxes}
                    onValueChange={(value) =>
                        setHeld((current) => ({
                            ...current,
                            mailboxes: value as core.MailMailboxScope
                        }))
                    }
                    options={core.MAIL_MAILBOX_SCOPES.map((scope) => ({
                        value: scope,
                        label: mailOptionLabel(tm, "mailboxScope", scope)
                    }))}
                />
            </Field>

            <Field
                label={t("general.sort")}
                hint={t("general.sortHint")}
            >
                <Select
                    aria-label={t("general.sort")}
                    value={held.sort}
                    onValueChange={(value) =>
                        setHeld((current) => ({ ...current, sort: value as core.MailSort }))
                    }
                    options={core.MAIL_SORTS.map((sort) => ({
                        value: sort,
                        label: mailOptionLabel(tm, "sort", sort)
                    }))}
                />
            </Field>

            <Field
                label={t("general.markRead")}
                hint={t("general.markReadHint")}
            >
                <Select
                    aria-label={t("general.markRead")}
                    value={held.markRead}
                    onValueChange={(value) =>
                        setHeld((current) => ({ ...current, markRead: value as core.MailMarkRead }))
                    }
                    options={core.MAIL_MARK_READ.map((mode) => ({
                        value: mode,
                        label: mailOptionLabel(tm, "markRead", mode)
                    }))}
                />
            </Field>

            <Field
                label={t("general.afterFiling")}
                hint={t("general.afterFilingHint")}
            >
                <Select
                    aria-label={t("general.afterFiling")}
                    value={held.afterFiling}
                    onValueChange={(value) =>
                        setHeld((current) => ({
                            ...current,
                            afterFiling: value as core.MailAfterFiling
                        }))
                    }
                    options={core.MAIL_AFTER_FILING.map((mode) => ({
                        value: mode,
                        label: mailOptionLabel(tm, "afterFiling", mode)
                    }))}
                />
            </Field>

            <Field
                label={t("general.undo")}
                hint={t("general.undoHint")}
            >
                <Select
                    aria-label={t("general.undo")}
                    value={String(held.undoSeconds)}
                    onValueChange={(value) =>
                        setHeld((current) => ({ ...current, undoSeconds: Number(value) }))
                    }
                    options={core.MAIL_UNDO_SECONDS.map((seconds) => ({
                        value: String(seconds),
                        label: t("general.undoSeconds", { seconds })
                    }))}
                />
            </Field>

            <div className="flex items-center gap-3">
                <Button disabled={saving || !changed} onClick={save}>
                    {saving ? t("shortcuts.saving") : tc("actions.save")}
                </Button>
                {changed ? (
                    <span className="text-[12px] text-muted-foreground">{t("shortcuts.unsaved")}</span>
                ) : null}
            </div>

            <div className="border-t border-border pt-5">
                <MailtoHandler />
            </div>

            <div className="border-t border-border pt-5">
                <Field
                    label={t("general.layout")}
                    hint={t("general.layoutHint")}
                >
                    <Select
                        aria-label={t("general.layout")}
                        value={layout}
                        onValueChange={(value) =>
                            chooseLayout(value === "split" ? "split" : "full")
                        }
                        options={[
                            { value: "full", label: t("general.layoutFull") },
                            { value: "split", label: t("general.layoutSplit") }
                        ]}
                    />
                </Field>
            </div>
        </div>
    );
}

/**
 * Make Polaris the browser's handler for `mailto:` links.
 *
 * Remembered by the browser, not by Polaris, which is why it is a button on
 * this device rather than a setting on the account: every browser asks for its
 * own permission, and the answer lives in its settings. The address handed over
 * is this page's own origin because a browser refuses any other - a handler must
 * be on the site that registers it.
 */
function MailtoHandler() {
    const toast = useToast();
    const t = useTranslations("mailSettings");
    const [supported, setSupported] = useState<boolean | null>(null);
    useEffect(() => {
        setSupported(typeof navigator !== "undefined" && "registerProtocolHandler" in navigator);
    }, []);

    return (
        <Field
            label={t("general.mailto")}
            hint={t("general.mailtoHint")}
        >
            {supported === false ? (
                <p className="text-[13px] text-muted-foreground">
                    {t("general.mailtoUnsupported")}
                </p>
            ) : (
                <Button
                    variant="secondary"
                    disabled={supported === null}
                    onClick={() => {
                        try {
                            navigator.registerProtocolHandler(
                                "mailto",
                                `${window.location.origin}/mail/compose?url=%s`
                            );
                            toast.show({ title: t("general.mailtoConfirm") });
                        } catch {
                            // Refused outright - most often because this page is
                            // not served over https, which a handler requires.
                            toast.show({
                                title: t("general.mailtoRefused")
                            });
                        }
                    }}
                >
                    {t("general.mailtoButton")}
                </Button>
            )}
        </Field>
    );
}

/** One question, its answer, and the sentence that says why it is worth asking.
 *  A label over a control with the reasoning under it, which is the shape the
 *  rest of Mail's settings already use.
 *
 *  The question is drawn here and said again on the control as its `aria-label`,
 *  because what this wraps is a listbox rather than a labelable field: without
 *  it, somebody reading the screen aloud is offered five dropdowns and told what
 *  none of them is for. */
function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
    return (
        <div className="space-y-1">
            <span className="block text-[13px] font-medium">{label}</span>
            <div className="max-w-sm">{children}</div>
            <p className="text-[12px] text-muted-foreground">{hint}</p>
        </div>
    );
}
