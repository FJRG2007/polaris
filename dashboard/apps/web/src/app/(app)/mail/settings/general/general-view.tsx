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
import { useState, useTransition, type ReactNode } from "react";
import { useMailLayout } from "@/app/(app)/mail/use-mail-layout";
import { setMailPreferencesAction } from "@/app/(app)/mail/actions";

export function GeneralView({ preferences }: { preferences: core.MailPreferences }) {
    const toast = useToast();
    const [saving, startSaving] = useTransition();
    const [held, setHeld] = useState<core.MailPreferences>(preferences);
    const [layout, chooseLayout] = useMailLayout();

    /** Whether anything on the form differs from what is stored. A Save that is
     *  always pressable is a Save nobody can tell they have used. */
    const changed =
        held.sort !== preferences.sort ||
        held.markRead !== preferences.markRead ||
        held.afterFiling !== preferences.afterFiling ||
        held.undoSeconds !== preferences.undoSeconds;

    function save(): void {
        startSaving(async () => {
            const answer = await setMailPreferencesAction(held);
            const said = refusalOf(answer);
            toast.show({ title: said ?? "Saved." });
        });
    }

    return (
        <div className="space-y-5">
            <Field
                label="Sort lists by"
                hint="What every list opens as. The buttons above a list still win for the page you are on, and that page is a link you can send."
            >
                <Select
                    aria-label="Sort lists by"
                    value={held.sort}
                    onValueChange={(value) =>
                        setHeld((current) => ({ ...current, sort: value as core.MailSort }))
                    }
                    options={core.MAIL_SORTS.map((sort) => ({
                        value: sort,
                        label: core.MAIL_SORT_LABELS[sort]
                    }))}
                />
            </Field>

            <Field
                label="Mark a message as read"
                hint="Passing over a message in a reading pane is not the same as reading it, and a message marked read is a message lost."
            >
                <Select
                    aria-label="Mark a message as read"
                    value={held.markRead}
                    onValueChange={(value) =>
                        setHeld((current) => ({ ...current, markRead: value as core.MailMarkRead }))
                    }
                    options={core.MAIL_MARK_READ.map((mode) => ({
                        value: mode,
                        label: core.MAIL_MARK_READ_LABELS[mode]
                    }))}
                />
            </Field>

            <Field
                label="After archiving or deleting"
                hint="Clearing four hundred messages by going back to the list each time is the job done twice."
            >
                <Select
                    aria-label="After archiving or deleting"
                    value={held.afterFiling}
                    onValueChange={(value) =>
                        setHeld((current) => ({
                            ...current,
                            afterFiling: value as core.MailAfterFiling
                        }))
                    }
                    options={core.MAIL_AFTER_FILING.map((mode) => ({
                        value: mode,
                        label: core.MAIL_AFTER_FILING_LABELS[mode]
                    }))}
                />
            </Field>

            <Field
                label="Undo send"
                hint="How long a message waits before it actually goes. Off means Send is final."
            >
                <Select
                    aria-label="Undo send"
                    value={String(held.undoSeconds)}
                    onValueChange={(value) =>
                        setHeld((current) => ({ ...current, undoSeconds: Number(value) }))
                    }
                    options={core.MAIL_UNDO_SECONDS.map((seconds) => ({
                        value: String(seconds),
                        label: core.mailUndoLabel(seconds)
                    }))}
                />
            </Field>

            <div className="flex items-center gap-3">
                <Button disabled={saving || !changed} onClick={save}>
                    {saving ? "Saving..." : "Save"}
                </Button>
                {changed ? (
                    <span className="text-[12px] text-muted-foreground">Not saved yet.</span>
                ) : null}
            </div>

            <div className="border-t border-border pt-5">
                <Field
                    label="Reading layout"
                    hint="Remembered for this browser rather than for your account: a phone and a desk are not the same shape."
                >
                    <Select
                        aria-label="Reading layout"
                        value={layout}
                        onValueChange={(value) =>
                            chooseLayout(value === "split" ? "split" : "full")
                        }
                        options={[
                            { value: "full", label: "The message fills the screen" },
                            { value: "split", label: "A list beside the message" }
                        ]}
                    />
                </Field>
            </div>
        </div>
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
