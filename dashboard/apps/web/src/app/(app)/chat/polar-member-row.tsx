"use client";

/**
 * "Polar in this chat" in a sealed conversation's info: the switch that adds
 * Polar as a member or takes it out, with what adding it means said under it -
 * what reaches Polar is read by whoever runs Polaris and the model provider.
 *
 * Drawn only while sealed chat is on (`sealedChatActive`): anywhere else Polar
 * answers a mention without being a member, and the switch would mean nothing.
 * The last answer is drawn at once from this page's memory and asked again in
 * the background; the switch moves on the spot and goes back if refused.
 */

import { Bot } from "lucide-react";
import * as actions from "./actions";
import { useEffect, useId, useState } from "react";
import { Switch, cn, useToast } from "@polaris/ui";
import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";
import { POLAR_SERVICE_ID } from "@/lib/chat/service-ids";
import { useTranslations } from "@/components/i18n/i18n-provider";

interface Membership {
    readonly added: boolean;
    readonly mayChange: boolean;
}

/** What this page last heard per conversation, so reopening the info draws at once. */
const known = new Map<string, Membership>();

export function PolarMemberRow({ channelId, rowClass }: { channelId: string; rowClass: string }) {
    const t = useTranslations("chat");
    const toast = useToast();
    const hintId = useId();
    const active = sealedChat.sealedChatActive();
    const [membership, setMembership] = useState<Membership | null>(() => known.get(channelId) ?? null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!active) return;
        let live = true;
        void actions
            .polarMembershipAction(channelId)
            .then((answer) => {
                if (!live || !answer.membership) return;
                known.set(channelId, answer.membership);
                setMembership(answer.membership);
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [active, channelId]);

    if (!active || !membership) return null;

    const toggle = async (on: boolean) => {
        const before = membership;
        const next = { ...membership, added: on };
        setMembership(next);
        setSaving(true);
        try {
            const answer = await actions.setPolarMemberAction({ channelId, on });
            if (answer.error) throw new Error(answer.error);
            known.set(channelId, next);
            // Its leaf leaves the group from here, so what is said next is sealed to keys it no longer holds.
            if (!on) void sealedChat.removeSealedAccounts(channelId, [POLAR_SERVICE_ID]).catch(() => undefined);
        } catch (caught) {
            setMembership(before);
            toast.show({
                key: `chat-polar-${channelId}`,
                title: t("info.notSaved"),
                body: caught instanceof Error && caught.message ? caught.message : undefined
            });
        } finally {
            setSaving(false);
        }
    };

    const label = t("info.polar");
    return (
        <div className="flex flex-col">
            <label className={cn(rowClass, membership.mayChange ? "cursor-pointer" : "cursor-not-allowed text-foreground-subtle")}>
                <Bot />
                <span className="min-w-0 flex-1 truncate" title={label}>
                    {label}
                </span>
                <Switch
                    checked={membership.added}
                    disabled={!membership.mayChange || saving}
                    onChange={(on) => void toggle(on)}
                    aria-label={label}
                    aria-describedby={hintId}
                />
            </label>
            <p id={hintId} className="px-3 pb-2 text-xs text-muted-foreground">
                {t("info.polarHint")}
                {!membership.mayChange && ` ${t("info.polarNotYours")}`}
            </p>
        </div>
    );
}
