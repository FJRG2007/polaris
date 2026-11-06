"use client";

/**
 * The two dialogs of the chat lock: asking for the code, and setting it.
 *
 * The code box is the shared password input, so it has its show/hide toggle.
 * Both stay open on a refusal with the reason under the box.
 */

import type { LockShelf } from "./lock-shelf";
import { ArrowLeft, EyeOff, Lock, Settings } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { keepUnlockProofs } from "./lock-session";
import { useChatStream } from "./use-chat-stream";
import { StepUpDialog } from "@/components/step-up-dialog";
import { runAction } from "@/lib/run-action";
import type { ChatLockState } from "@/lib/chat/chat-lock";
import * as lockActions from "./lock-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Switch
} from "@polaris/ui";

/** Same bounds as `lockCodeSchema`, so the box never offers what is refused. */
const CODE_MIN = 4;
const CODE_MAX = 64;

function codeReady(code: string): boolean {
    const length = code.trim().length;
    return length >= CODE_MIN && length <= CODE_MAX;
}

const NO_LOCK: ChatLockState = { hasCode: false, hideLocked: false };

/** "Forgot code?": confirm it is the account's owner, then the code goes and
 *  every chat it locked opens. */
function ForgotCode({ onReset }: { onReset: () => void }) {
    const t = useTranslations("chat");
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState("");
    return (
        <>
            <Button
                type="button"
                variant="ghost"
                size="xs"
                className="self-start"
                onClick={() => {
                    setError("");
                    setConfirming(true);
                }}
            >
                {t("lock.forgot")}
            </Button>
            {error ? (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : null}
            <StepUpDialog
                open={confirming}
                purpose="chat-lock-reset"
                title={t("lock.resetTitle")}
                description={t("lock.resetHint")}
                onOpenChange={setConfirming}
                onProved={async () => {
                    const result = await runAction(
                        () => lockActions.resetLockCodeAction(),
                        setError
                    );
                    if (!result) return;
                    if (result.error) {
                        setError(result.error);
                        return;
                    }
                    onReset();
                }}
            />
        </>
    );
}

/** Asks for the code. `submit` answers with a refusal, or nothing when it took. */
export function LockCodeDialog({
    open,
    onOpenChange,
    title,
    submit,
    onReset
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    submit: (code: string) => Promise<string | undefined>;
    /** After a forgotten code was taken away: nothing is locked any more. */
    onReset?: () => void;
}) {
    const t = useTranslations("chat");
    const lock = useChatLock();
    const [code, setCode] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (open) {
            setCode("");
            setError("");
        }
    }, [open]);

    async function send(): Promise<void> {
        if (!codeReady(code) || busy) return;
        setBusy(true);
        const refused = await runAction(() => submit(code), setError);
        setBusy(false);
        if (refused === null) return;
        if (refused) {
            setError(refused);
            return;
        }
        onOpenChange(false);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>
                <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void send();
                    }}
                >
                    <Input
                        type="password"
                        autoFocus
                        autoComplete="off"
                        value={code}
                        maxLength={CODE_MAX}
                        aria-label={t("lock.code")}
                        placeholder={t("lock.code")}
                        aria-invalid={error ? true : undefined}
                        onChange={(event) => {
                            setCode(event.target.value);
                            setError("");
                        }}
                    />
                    {error ? (
                        <p role="alert" className="text-xs text-danger">
                            {error}
                        </p>
                    ) : null}
                    <ForgotCode
                        onReset={() => {
                            lock.setState(NO_LOCK);
                            onOpenChange(false);
                            onReset?.();
                        }}
                    />
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => onOpenChange(false)}
                        >
                            {t("lock.cancel")}
                        </Button>
                        <Button type="submit" size="sm" disabled={!codeReady(code) || busy}>
                            {t("lock.open")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Set or change the code, and choose whether locked chats leave the list. */
export function LockSettingsDialog({
    open,
    onOpenChange,
    state,
    onChanged
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    state: ChatLockState;
    onChanged: (state: ChatLockState) => void;
}) {
    const t = useTranslations("chat");
    const [current, setCurrent] = useState("");
    const [code, setCode] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (open) {
            setCurrent("");
            setCode("");
            setError("");
        }
    }, [open]);

    const ready = codeReady(code) && (!state.hasCode || codeReady(current)) && !busy;

    async function save(): Promise<void> {
        if (!ready) return;
        setBusy(true);
        const result = await runAction(
            () =>
                lockActions.setLockCodeAction({
                    code,
                    current: state.hasCode ? current : undefined
                }),
            setError
        );
        setBusy(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        onChanged({ ...state, hasCode: true });
        onOpenChange(false);
    }

    async function chooseHide(hide: boolean): Promise<void> {
        const before = state;
        // Drawn at once, put back on a refusal.
        onChanged({ ...state, hideLocked: hide });
        const result = await runAction(() => lockActions.setHideLockedAction({ hide }), setError);
        if (!result || result.error) {
            onChanged(before);
            if (result?.error) setError(result.error);
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("lock.settings")}</DialogTitle>
                </DialogHeader>
                <p className="text-xs text-muted-foreground">{t("lock.settingsHint")}</p>
                <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    {state.hasCode && (
                        <Input
                            type="password"
                            autoComplete="off"
                            value={current}
                            maxLength={CODE_MAX}
                            aria-label={t("lock.currentCode")}
                            placeholder={t("lock.currentCode")}
                            onChange={(event) => {
                                setCurrent(event.target.value);
                                setError("");
                            }}
                        />
                    )}
                    {state.hasCode && (
                        <ForgotCode
                            onReset={() => {
                                setCurrent("");
                                onChanged(NO_LOCK);
                            }}
                        />
                    )}
                    {/* enigma:allow-no-breach-check enigma:allow-identity-password - a
                        chat lock code is a short PIN over a session that is already
                        signed in, not an account password: it opens nothing on its
                        own, guesses are throttled server-side, and a breach list
                        would refuse every four-digit code. */}
                    <Input
                        type="password"
                        autoComplete="new-password"
                        value={code}
                        maxLength={CODE_MAX}
                        aria-label={t("lock.newCode")}
                        placeholder={t("lock.newCode")}
                        onChange={(event) => {
                            setCode(event.target.value);
                            setError("");
                        }}
                    />
                    <p className="text-xs text-foreground-subtle">{t("lock.codeHint")}</p>
                    {error ? (
                        <p role="alert" className="text-xs text-danger">
                            {error}
                        </p>
                    ) : null}
                    <div className="flex justify-end">
                        <Button type="submit" size="sm" disabled={!ready}>
                            {state.hasCode ? t("lock.changeCode") : t("lock.setCode")}
                        </Button>
                    </div>
                </form>
                <label className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0">{t("lock.hideLocked")}</span>
                    <Switch
                        checked={state.hideLocked}
                        disabled={!state.hasCode}
                        aria-label={t("lock.hideLocked")}
                        onChange={(checked) => void chooseHide(checked)}
                    />
                </label>
                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        {t("lock.cancel")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * What stands where a locked conversation would be until the code is given.
 * The dialog opens by itself; closing it leaves the button to open it again.
 */
export function LockedGate({
    channelId,
    onUnlocked,
    onReset
}: {
    channelId: string;
    onUnlocked: () => void;
    /** After a forgotten code was taken away: the conversation is not locked. */
    onReset?: () => void;
}) {
    const t = useTranslations("chat");
    const [asking, setAsking] = useState(true);
    return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto overscroll-contain p-6">
            <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Lock className="size-6 shrink-0" />
                </span>
                <h2 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("lock.lockedNotice")}
                </h2>
                <Button size="sm" onClick={() => setAsking(true)}>
                    {t("lock.open")}
                </Button>
            </div>
            <LockCodeDialog
                open={asking}
                onOpenChange={setAsking}
                title={t("lock.enterCode")}
                onReset={onReset ?? onUnlocked}
                submit={async (code) => {
                    const result = await lockActions.unlockChannelAction({ channelId, code });
                    if (result.error || !result.proof) return result.error ?? t("lock.failed");
                    keepUnlockProofs({ [channelId]: result.proof });
                    onUnlocked();
                    return undefined;
                }}
            />
        </div>
    );
}

interface ChatLockContextValue {
    readonly state: ChatLockState;
    readonly setState: (state: ChatLockState) => void;
    /** Opens the settings dialog: setting the code comes first. */
    readonly openSettings: () => void;
}

const ChatLockContext = createContext<ChatLockContextValue>({
    state: { hasCode: false, hideLocked: false },
    setState: () => undefined,
    openSettings: () => undefined
});

export function useChatLock(): ChatLockContextValue {
    return useContext(ChatLockContext);
}

/** The reader's lock state for the sidebar and its row menus, with the
 *  settings dialog they open. */
export function ChatLockProvider({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<ChatLockState>(NO_LOCK);
    const [settings, setSettings] = useState(false);
    const [asked, setAsked] = useState(0);
    useEffect(() => {
        let live = true;
        void runAction(
            () => lockActions.lockStateAction(),
            () => undefined
        ).then((answer) => {
            if (live && answer) setState(answer);
        });
        return () => {
            live = false;
        };
    }, [asked]);
    // A code taken away from the open conversation, or from another tab.
    useChatStream(
        useCallback((frame) => {
            if (frame.kind === "channels") setAsked((count) => count + 1);
        }, [])
    );
    const value = useMemo(
        () => ({ state, setState, openSettings: () => setSettings(true) }),
        [state]
    );
    return (
        <ChatLockContext.Provider value={value}>
            {children}
            <LockSettingsDialog
                open={settings}
                onOpenChange={setSettings}
                state={state}
                onChanged={setState}
            />
        </ChatLockContext.Provider>
    );
}

/** The sidebar's "Locked chats" and "Hidden chats" entries, and the header that
 *  takes the list back to every chat while one of them is open. */
export function LockShelfEntries({
    shelf,
    onShelf,
    hiddenCount,
    lockedCount
}: {
    shelf: LockShelf;
    onShelf: (shelf: LockShelf) => void;
    hiddenCount: number;
    lockedCount: number;
}) {
    const t = useTranslations("chat");
    const { state, openSettings } = useChatLock();
    const [asking, setAsking] = useState(false);
    const entry =
        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-card-hover";

    if (shelf !== "all")
        return (
            <div className="mb-2 flex items-center gap-1">
                <button
                    type="button"
                    className={`${entry} min-w-0 flex-1 text-muted-foreground`}
                    onClick={() => onShelf("all")}
                >
                    <ArrowLeft className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">
                        {shelf === "locked" ? t("lock.lockedChats") : t("lock.hiddenChats")}
                    </span>
                </button>
                {shelf === "locked" ? (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0"
                        aria-label={t("lock.manage")}
                        title={t("lock.manage")}
                        onClick={openSettings}
                    >
                        <Settings className="size-3.5 shrink-0" />
                    </Button>
                ) : null}
            </div>
        );

    return (
        <>
            <button
                type="button"
                className={`${entry} text-muted-foreground`}
                onClick={() => (state.hasCode ? setAsking(true) : openSettings())}
            >
                <Lock className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                    {state.hasCode ? t("lock.lockedChats") : t("lock.settings")}
                </span>
                {state.hasCode && lockedCount > 0 ? (
                    <span className="shrink-0 text-xs tabular-nums text-foreground-subtle">
                        {lockedCount}
                    </span>
                ) : null}
            </button>
            {hiddenCount > 0 ? (
                <button
                    type="button"
                    className={`${entry} text-muted-foreground`}
                    onClick={() => onShelf("hidden")}
                >
                    <EyeOff className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{t("lock.hiddenChats")}</span>
                    <span className="shrink-0 text-xs tabular-nums text-foreground-subtle">
                        {hiddenCount}
                    </span>
                </button>
            ) : null}
            <LockCodeDialog
                open={asking}
                onOpenChange={setAsking}
                title={t("lock.enterCode")}
                submit={async (code) => {
                    const result = await lockActions.openLockedChatsAction({ code });
                    if (result.error || !result.proofs) return result.error ?? t("lock.failed");
                    keepUnlockProofs(result.proofs);
                    onShelf("locked");
                    return undefined;
                }}
            />
        </>
    );
}
