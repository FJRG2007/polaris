"use client";

/**
 * The two things a room full of devices has to be told, and the one question it
 * has to be asked.
 *
 * The strip is the whole visible surface of combining - see `call-combine` for
 * what a group is and `call-nearby` for how one is noticed. It says one of three
 * things and never more than one: this device is quiet and where its voice is
 * going instead, this device is carrying the room for others, or somebody has
 * been heard sitting next to it.
 *
 * The suggestion is worded as an observation rather than an instruction, because
 * it is a measurement of a room that may be wrong: `sounds like` is what the
 * microphone actually established. Dismissing it is a real option and it holds
 * for as long as the screen is open - somebody who says no is not asked again by
 * the next roster change.
 */

import type { CallState } from "./call-state";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useState, type ReactNode } from "react";
import { Headphones, Users, Volume2, X } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

/** Whoever holds that seat, named. A seat with nobody behind it is somebody who
 *  has just left, which reads better as "somebody" than as a uuid. */
function nameOf(call: CallState, seat: string | null): string {
    if (!seat) return "somebody";
    return call.meeting?.participants.find((person) => person.id === seat)?.name ?? "somebody";
}

export function CombineStrip({ call }: { call: CallState }) {
    const t = useTranslations("chat");
    /** Who has been turned down, for as long as this screen is open. */
    const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

    if (call.audioRole === "companion") {
        return (
            <Strip
                icon={<Headphones className="size-4 shrink-0 text-primary" />}
                text={
                    <>
                        {t.rich<ReactNode>("combine.companion", {
                            name: nameOf(call, call.audioHost),
                            strong: (chunks) => (
                                <span key="name" className="font-medium">
                                    {chunks}
                                </span>
                            )
                        })}
                    </>
                }
            >
                <Button size="sm" variant="secondary" onClick={call.leaveCombine}>
                    {t("combine.useMyOwnAudio")}
                </Button>
            </Strip>
        );
    }

    if (call.audioRole === "room") {
        const others = call.audioMembers.length;
        return (
            <Strip
                icon={<Users className="size-4 shrink-0 text-primary" />}
                text={
                    <>
                        {t("combine.carrying", { count: others })}
                    </>
                }
            />
        );
    }

    // Two people cannot combine: they are the whole call.
    if (!call.combineOpen) return null;

    const admitted = new Set(
        (call.meeting?.participants ?? [])
            .filter((person) => person.admission === "admitted")
            .map((person) => person.id)
    );
    // One at a time. Three people walking into a meeting room with three laptops
    // is three suggestions, and a bar of them is worse than the echo.
    const heard = [...call.nearby].find((seat) => admitted.has(seat) && !dismissed.has(seat));
    if (!heard) return null;
    const name = nameOf(call, heard);

    return (
        <Strip
            icon={<Volume2 className="size-4 shrink-0 text-primary" />}
            text={
                <>
                    {t.rich<ReactNode>("combine.heard", {
                        name,
                        strong: (chunks) => (
                                <span key="name" className="font-medium">
                                    {chunks}
                                </span>
                            )
                    })}
                </>
            }
        >
            <Button size="sm" onClick={() => call.combineWith(heard)}>
                {t("combine.useTheirAudio")}
            </Button>
            <Button
                size="sm"
                variant="secondary"
                disabled={call.combineAsked === heard}
                onClick={() => call.askToCombine(heard)}
            >
                {call.combineAsked === heard ? t("combine.asked") : t("combine.askThemInstead")}
            </Button>
            <button
                type="button"
                aria-label={t("combine.notInThisRoom")}
                title={t("combine.notInThisRoom")}
                onClick={() => setDismissed((current) => new Set([...current, heard]))}
                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
                <X className="size-4" />
            </button>
        </Strip>
    );
}

function Strip({
    icon,
    text,
    children
}: {
    icon: ReactNode;
    text: ReactNode;
    children?: ReactNode;
}) {
    return (
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
            {icon}
            <span className="min-w-0 flex-1">{text}</span>
            {children}
        </div>
    );
}

/**
 * Somebody asking this device to go quiet.
 *
 * A dialog rather than a strip, and that is deliberate: accepting turns off this
 * microphone and these speakers, which is the one thing in a call nobody should
 * be able to do to somebody else without being noticed asking.
 */
export function CombineRequestDialog({ call }: { call: CallState }) {
    const t = useTranslations("chat");
    const asking = call.combineRequest;
    if (!asking || !call.combineOpen) return null;
    const name = nameOf(call, asking.from);

    return (
        <Dialog open onOpenChange={(open) => !open && call.answerCombine(false)}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("combine.requestTitle", { name })}</DialogTitle>
                    <DialogDescription>
                        {t("combine.requestBody", { name })}
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => call.answerCombine(false)}>
                        {t("combine.notInTheSameRoom")}
                    </Button>
                    <Button onClick={() => call.answerCombine(true)}>{t("combine.combineAudio")}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
