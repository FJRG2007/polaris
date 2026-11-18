"use client";

/**
 * Disappearing messages, delete for me and deleting a chat, as the screen
 * draws them - see `lib/chat/vanish` for the server half, which asks the same
 * questions of every call. Everything here follows the rules the server hands
 * back (`directRulesAction`): what it would refuse is not offered, or is drawn
 * refused with the reason.
 */

import { runAction } from "@/lib/run-action";
import * as vanishActions from "./vanish-actions";
import { Check, Eye, PenLine, Timer, Trash2 } from "lucide-react";
import type { ChatRulesChange } from "./chat-privacy-section";
import type { DirectRulesView } from "@/lib/chat/vanish";
import type { ChatMessageView } from "@/lib/chat/messages";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    CHAT_PRIVACY_RULES,
    isExpired,
    VANISH_DURATIONS,
    type ChatPrivacyRule,
    type VanishDuration
} from "@/lib/chat/vanish-rules";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction
} from "react";
import {
    Button,
    Checkbox,
    ConfirmDeleteDialog,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    cn
} from "@polaris/ui";

/** The word each timer is called by, for its translation keys. */
const DURATION_NAMES = {
    0: "off",
    86_400: "day",
    604_800: "week",
    2_592_000: "month",
    7_776_000: "quarter"
} as const satisfies Record<VanishDuration, string>;

export function durationName(seconds: number): (typeof DURATION_NAMES)[VanishDuration] {
    return DURATION_NAMES[seconds as VanishDuration] ?? "off";
}

/** The longest a browser timer may wait; anything later is waited for in
 *  steps of this. */
const LONGEST_WAIT = 2_147_483_647;

/** These messages without the ones past their expiry, or the same array when
 *  none is, so a check that finds nothing does not draw the list again. */
export function withoutExpired(
    messages: readonly ChatMessageView[],
    now: number
): readonly ChatMessageView[] {
    const kept = messages.filter((message) => !isExpired(message.expiresAt, now));
    return kept.length === messages.length ? messages : kept;
}

/** When the next of these messages disappears, or null if none will. */
export function nextExpiry(messages: readonly ChatMessageView[], now: number): number | null {
    let next: number | null = null;
    for (const message of messages) {
        if (!message.expiresAt) continue;
        const at = Date.parse(message.expiresAt);
        if (at > now && (next === null || at < next)) next = at;
    }
    return next;
}

/** Take each message off the screen the moment it disappears. The server has
 *  stopped serving it by then too; its sweep then tells every other screen. */
export function useDropExpired(
    messages: readonly ChatMessageView[] | null,
    setMessages: Dispatch<SetStateAction<readonly ChatMessageView[] | null>>
): void {
    useEffect(() => {
        if (!messages) return;
        const now = Date.now();
        if (withoutExpired(messages, now) !== messages) {
            setMessages((current) => current && withoutExpired(current, Date.now()));
            return;
        }
        const next = nextExpiry(messages, now);
        if (next === null) return;
        const timer = setTimeout(
            () => setMessages((current) => current && withoutExpired(current, Date.now())),
            Math.min(next - now, LONGEST_WAIT)
        );
        return () => clearTimeout(timer);
    }, [messages, setMessages]);
}

/** The rules of one direct conversation, as the server says them, or null
 *  where it has none (a space's channel) or before they have arrived. */
export function useDirectRules(channelId: string, applies: boolean) {
    const [rules, setRules] = useState<DirectRulesView | null>(null);
    const asked = useRef(0);
    const reload = useCallback(async () => {
        const ask = ++asked.current;
        if (!applies) {
            setRules(null);
            return;
        }
        const result = await vanishActions.directRulesAction(channelId).catch(() => null);
        // A conversation switched to in the meantime answers for itself.
        if (ask !== asked.current || !result || result.error) return;
        setRules(result.rules ?? null);
    }, [channelId, applies]);
    useEffect(() => {
        setRules(null);
        void reload();
    }, [reload]);
    return { rules, setRules, reload };
}

/** "Delete for me" on a message, handed to every message menu below it. */
export const HideMessage = createContext<((message: ChatMessageView) => void) | null>(null);

export function useHideMessage(): ((message: ChatMessageView) => void) | null {
    return useContext(HideMessage);
}

/** Take a message off this reader's screen at once, and put it back where it
 *  was, with the reason, if the server refuses. */
export function useHide(
    setMessages: Dispatch<SetStateAction<readonly ChatMessageView[] | null>>,
    setError: (message: string) => void
): (message: ChatMessageView) => void {
    return useCallback(
        (message: ChatMessageView) => {
            setMessages((current) => current && current.filter((one) => one.id !== message.id));
            void (async () => {
                const result = await runAction(
                    () => vanishActions.hideMessageAction(message.id),
                    setError
                );
                if (result && !result.error) return;
                if (result?.error) setError(result.error);
                setMessages((current) =>
                    current && !current.some((one) => one.id === message.id)
                        ? [...current, message].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                        : current
                );
            })();
        },
        [setMessages, setError]
    );
}

/** The timer beside a conversation's name, when it has one. */
export function VanishBadge({ seconds }: { seconds: number }) {
    const t = useTranslations("chat");
    if (!seconds) return null;
    const duration = t(`vanish.duration.${durationName(seconds)}`);
    const label = t("vanish.badge", { duration });
    return (
        <span
            className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
            title={label}
        >
            <Timer className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">{t(`vanish.short.${durationName(seconds)}`)}</span>
            <span className="sr-only">{label}</span>
        </span>
    );
}

/** The mark on a message that will disappear. */
export function VanishMark({ expiresAt }: { expiresAt?: string }) {
    const t = useTranslations("chat");
    if (!expiresAt) return null;
    const label = t("vanish.mark");
    return (
        <span title={label} className="inline-flex shrink-0 text-foreground-subtle">
            <Timer className="size-3" aria-hidden />
            <span className="sr-only">{label}</span>
        </span>
    );
}

/** The header menu's part: the timer, and in the agreement mode whether the
 *  chat may be deleted for everybody, both proposed rather than set. */
export function VanishMenu({
    rules,
    onTimer,
    onAllowDelete,
    onRules,
    onDeleteChat
}: {
    rules: DirectRulesView;
    onTimer: (seconds: VanishDuration) => void;
    onAllowDelete: (allowed: boolean) => void;
    /** Read receipts and the typing indicator, the same change the privacy
     *  section makes. */
    onRules: (change: ChatRulesChange) => void;
    onDeleteChat: () => void;
}) {
    const t = useTranslations("chat");
    const agreement = rules.mode === "agreement";
    const ruleMenu = (key: "receipts" | "typing", Icon: typeof Eye) => (
        <DropdownMenuSub key={key}>
            <DropdownMenuSubTrigger>
                <Icon className="size-3.5" />
                {t(`chatPrivacy.${key}`)}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                {rules.proposes && (
                    <p className="max-w-56 px-2 py-1 text-[0.6875rem] text-foreground-subtle">
                        {t("vanish.proposeHint")}
                    </p>
                )}
                {CHAT_PRIVACY_RULES.map((rule: ChatPrivacyRule) => (
                    <DropdownMenuItem key={rule} onSelect={() => onRules({ [key]: rule })}>
                        <Check className={cn("size-3.5", rules[key] !== rule && "invisible")} />
                        {t(`chatPrivacy.${rule}`)}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
    return (
        <>
            <DropdownMenuSeparator />
            {/* The conversation's privacy, beside its timer: the same three
                rows its profile panel draws, so neither place hides one. */}
            {rules.mayChange && ruleMenu("receipts", Eye)}
            {rules.mayChange && ruleMenu("typing", PenLine)}
            {/* A group member who does not run it reads the timer in the
                privacy section, with the reason; the menu offers only what
                they may do. */}
            {rules.mayChange && (
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <Timer className="size-3.5" />
                        {t("vanish.timer")}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        {rules.proposes && (
                            <p className="max-w-56 px-2 py-1 text-[0.6875rem] text-foreground-subtle">
                                {t("vanish.proposeHint")}
                            </p>
                        )}
                        {VANISH_DURATIONS.map((seconds) => (
                            <DropdownMenuItem key={seconds} onSelect={() => onTimer(seconds)}>
                                <Check
                                    className={cn(
                                        "size-3.5",
                                        rules.vanishAfter !== seconds && "invisible"
                                    )}
                                />
                                {t(`vanish.duration.${durationName(seconds)}`)}
                            </DropdownMenuItem>
                        ))}
                        {agreement && (
                            <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={() => onAllowDelete(!rules.deleteForAll)}>
                                    <Check
                                        className={cn("size-3.5", !rules.deleteForAll && "invisible")}
                                    />
                                    {t("vanish.allowDeleteForAll")}
                                </DropdownMenuItem>
                            </>
                        )}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            )}
            <DropdownMenuItem variant="danger" onSelect={onDeleteChat}>
                <Trash2 className="size-3.5" />
                {t("vanish.deleteChat")}
            </DropdownMenuItem>
        </>
    );
}

/**
 * Delete the chat: for me always, and for everybody in it too where the rules
 * allow - the box is there either way, refused with the reason where they do
 * not, so nobody has to wonder whether it exists.
 */
export function DeleteChatDialog({
    open,
    onOpenChange,
    name,
    rules,
    onDelete
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Who "also for" names: the other person, or the group. */
    name: string;
    rules: DirectRulesView;
    /** Resolves with the refusal, or null once it is done. */
    onDelete: (forEverybody: boolean) => Promise<string | null>;
}) {
    const t = useTranslations("chat");
    const [everybody, setEverybody] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!open) {
            setEverybody(false);
            setError(null);
        }
    }, [open]);
    const allowed = rules.deleteForAll;
    return (
        <ConfirmDeleteDialog
            open={open}
            onOpenChange={onOpenChange}
            name={name}
            kind={t("vanish.chatKind")}
            requireTyping={false}
            title={t("vanish.deleteTitle")}
            question={everybody && allowed ? t("vanish.forAllQuestion") : t("vanish.forMeQuestion")}
            confirmLabel={everybody && allowed ? t("vanish.deleteForAll") : t("vanish.deleteForMe")}
            pending={pending}
            error={error}
            onConfirm={() => {
                setPending(true);
                setError(null);
                void onDelete(everybody && allowed)
                    .then((refusal) => {
                        if (refusal) setError(refusal);
                        else onOpenChange(false);
                    })
                    .finally(() => setPending(false));
            }}
        >
            <label
                className={cn(
                    "flex items-start gap-2 text-sm",
                    !allowed && "cursor-not-allowed opacity-60"
                )}
            >
                <Checkbox
                    checked={everybody && allowed}
                    disabled={!allowed || pending}
                    onChange={(event) => setEverybody(event.currentTarget.checked)}
                    className="mt-0.5"
                />
                <span className="min-w-0">
                    <span className="block break-words">{t("vanish.alsoFor", { name })}</span>
                    <span className="block text-xs text-muted-foreground">
                        {allowed ? t("vanish.alsoForHint") : t("vanish.alsoForOff")}
                    </span>
                </span>
            </label>
        </ConfirmDeleteDialog>
    );
}

/** A proposal waiting in agreement mode: Accept / Decline for the ones it
 *  waits on, a quiet line for the one who made it. */
export function ProposalBar({
    rules,
    proposerName,
    onAnswer,
    onWithdraw
}: {
    rules: DirectRulesView;
    proposerName: string;
    onAnswer: (proposalId: string, accept: boolean) => Promise<void>;
    /** Take back a proposal this reader made. */
    onWithdraw?: (proposalId: string) => Promise<void>;
}) {
    const t = useTranslations("chat");
    const [busy, setBusy] = useState(false);
    const proposal = rules.proposal;
    if (!proposal || (!proposal.mayAnswer && !proposal.mine)) return null;
    // What the proposal changes, each as "what: to what"; the whole set when
    // it changes nothing but the delete rule.
    const changes: string[] = [];
    if (proposal.vanishAfter !== rules.vanishAfter) {
        changes.push(
            `${t("chatPrivacy.timer")}: ${t(`vanish.duration.${durationName(proposal.vanishAfter)}`)}`
        );
    }
    if (proposal.receipts !== rules.receipts) {
        changes.push(`${t("chatPrivacy.receipts")}: ${t(`chatPrivacy.${proposal.receipts}`)}`);
    }
    if (proposal.typing !== rules.typing) {
        changes.push(`${t("chatPrivacy.typing")}: ${t(`chatPrivacy.${proposal.typing}`)}`);
    }
    if (proposal.deleteForAll !== rules.deleteForAll || changes.length === 0) {
        changes.push(proposal.deleteForAll ? t("vanish.proposalDeleteYes") : t("vanish.proposalDeleteNo"));
    }
    const settle = (work: Promise<void>) => {
        setBusy(true);
        void work.finally(() => setBusy(false));
    };
    return (
        <div
            role="status"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-2"
        >
            <Timer className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="min-w-0 flex-1 text-xs">
                <span className="block break-words">
                    {proposal.mine ? t("vanish.waiting") : t("chatPrivacy.proposalBy", { name: proposerName })}
                </span>
                <span className="block break-words text-muted-foreground">{changes.join(" - ")}</span>
            </p>
            {proposal.mine && onWithdraw ? (
                <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => settle(onWithdraw(proposal.id))}
                >
                    {t("chatPrivacy.withdraw")}
                </Button>
            ) : null}
            {proposal.mayAnswer && (
                <div className="flex shrink-0 gap-2">
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => settle(onAnswer(proposal.id, false))}
                    >
                        {t("vanish.decline")}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => settle(onAnswer(proposal.id, true))}>
                        {t("vanish.accept")}
                    </Button>
                </div>
            )}
        </div>
    );
}
