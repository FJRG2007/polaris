"use client";

/**
 * The accounts signed in on this browser, the way Discord lists them: a face, a
 * name and an address per account, one press to act as it, one to sign it out,
 * and a way to add another. Drawn in the switcher dialog the account menu opens
 * and on the sessions page, from the same pieces.
 *
 * Switching and signing out the active account are full loads (see
 * `lib/account-switch`): the page, its streams and anything a call holds belong to
 * the account they were opened for.
 */

import { signOut } from "@/lib/auth-client";
import { Avatar } from "@/components/avatar";
import { leaveAccount } from "@/lib/account-switch";
import { Check, LogOut, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Skeleton,
    cn
} from "@polaris/ui";
import {
    deviceAccountsAction,
    prepareAddAccountAction,
    signOutAccountAction,
    signOutAllAccountsAction,
    switchAccountAction,
    type DeviceAccounts,
    type DeviceAccountView
} from "@/app/device-account-actions";

/** Where "add an account" sends the browser: the sign-in page, told not to send
 *  an already signed-in visitor straight back. */
export const ADD_ACCOUNT_PATH = "/oauth/login?add=1";

/** Loading the list and every action on it, shared by the dialog and the card. */
function useDeviceAccounts(enabled: boolean) {
    const t = useTranslations("nav");
    const [confirm, confirmElement] = useConfirm();
    const [data, setData] = useState<DeviceAccounts | null>(null);
    const [failed, setFailed] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** The account an action is running on, or "add" / "all". */
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        setFailed(false);
        try {
            setData(await deviceAccountsAction());
        } catch {
            setFailed(true);
        }
    }, []);

    useEffect(() => {
        if (enabled) void load();
    }, [enabled, load]);

    async function run(key: string, action: () => Promise<void>) {
        setBusy(key);
        setError(null);
        try {
            await action();
        } catch {
            setError(t("account.switcher.error"));
            setBusy(null);
        }
    }

    function switchTo(account: DeviceAccountView) {
        if (account.active) return;
        void run(account.id, async () => {
            const result = await switchAccountAction(account.id);
            if (result.error) {
                setError(result.error);
                setBusy(null);
                void load();
                return;
            }
            await leaveAccount("/");
        });
    }

    function signOutOf(account: DeviceAccountView) {
        void run(account.id, async () => {
            if (account.active) {
                const refused = await signOut();
                if (refused) {
                    setError(refused);
                    setBusy(null);
                }
                return;
            }
            const result = await signOutAccountAction(account.id);
            if (result.error) setError(result.error);
            setBusy(null);
            await load();
        });
    }

    async function signOutAll() {
        const ok = await confirm({
            title: t("account.switcher.signOutAllTitle"),
            description: t("account.switcher.signOutAllDescription"),
            confirmLabel: t("account.switcher.signOutAllConfirm"),
            danger: true
        });
        if (!ok) return;
        void run("all", async () => {
            const result = await signOutAllAccountsAction();
            if (result.error) {
                setError(result.error);
                setBusy(null);
                return;
            }
            await leaveAccount("/oauth/login");
        });
    }

    function add() {
        void run("add", async () => {
            const result = await prepareAddAccountAction();
            if (result.error) {
                setError(result.error);
                setBusy(null);
                return;
            }
            const back = `${window.location.pathname}${window.location.search}`;
            window.location.assign(`${ADD_ACCOUNT_PATH}&back=${encodeURIComponent(back)}`);
        });
    }

    return {
        data,
        failed,
        error,
        busy,
        load,
        switchTo,
        signOutOf,
        signOutAll,
        add,
        confirmElement
    };
}

function AccountRow({
    account,
    busy,
    disabled,
    onSwitch,
    onSignOut
}: {
    account: DeviceAccountView;
    busy: boolean;
    disabled: boolean;
    onSwitch: () => void;
    onSignOut: () => void;
}) {
    const t = useTranslations("nav");
    return (
        <li className="flex items-center gap-2">
            <button
                type="button"
                onClick={onSwitch}
                disabled={disabled || account.active}
                aria-current={account.active ? "true" : undefined}
                aria-label={
                    account.active
                        ? undefined
                        : t("account.switcher.switchTo", { name: account.name })
                }
                className={cn(
                    "flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
                    account.active ? "cursor-default" : "hover:bg-muted/60 disabled:opacity-60",
                    busy && "animate-pulse"
                )}
            >
                <Avatar
                    person={{ id: account.userId, name: account.name }}
                    size={36}
                    status={false}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium" title={account.name}>
                        {account.name}
                    </span>
                    <span className="truncate text-xs text-muted-foreground" title={account.email}>
                        {account.email}
                    </span>
                </span>
                {account.active ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-success">
                        <Check className="size-3.5" />
                        {t("account.switcher.active")}
                    </span>
                ) : null}
            </button>
            <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                onClick={onSignOut}
                aria-label={t("account.switcher.signOutOf", { name: account.name })}
                title={t("account.switcher.signOutOf", { name: account.name })}
                className="shrink-0"
            >
                <LogOut className="size-4" />
            </Button>
        </li>
    );
}

/** The list with its two buttons. */
function DeviceAccountsBody({ state }: { state: ReturnType<typeof useDeviceAccounts> }) {
    const t = useTranslations("nav");
    const { data, failed, error, busy } = state;
    const full = data !== null && data.room === 0;

    return (
        <div className="flex flex-col gap-3">
            {failed ? (
                <div className="flex items-center justify-between gap-2 text-sm text-danger">
                    <span className="min-w-0">{t("account.switcher.loadFailed")}</span>
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void state.load()}
                    >
                        {t("account.switcher.retry")}
                    </Button>
                </div>
            ) : data === null ? (
                <ul className="flex flex-col gap-1" aria-hidden>
                    {[0, 1].map((key) => (
                        <li key={key} className="flex items-center gap-3 px-2 py-2">
                            <Skeleton className="size-9 rounded-full" />
                            <span className="flex flex-1 flex-col gap-1.5">
                                <Skeleton className="h-3.5 w-32" />
                                <Skeleton className="h-3 w-44 max-w-full" />
                            </span>
                        </li>
                    ))}
                </ul>
            ) : (
                <ul className="flex flex-col gap-1">
                    {data.accounts.map((account) => (
                        <AccountRow
                            key={account.id}
                            account={account}
                            busy={busy === account.id}
                            disabled={busy !== null}
                            onSwitch={() => state.switchTo(account)}
                            onSignOut={() => state.signOutOf(account)}
                        />
                    ))}
                </ul>
            )}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    variant="secondary"
                    disabled={busy !== null || data === null || full}
                    onClick={state.add}
                >
                    <UserPlus className="size-4" />
                    {t("account.switcher.add")}
                </Button>
                {data !== null && data.accounts.length > 1 ? (
                    <Button
                        type="button"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void state.signOutAll()}
                    >
                        <LogOut className="size-4" />
                        {t("account.switcher.signOutAll")}
                    </Button>
                ) : null}
            </div>
            {full && data ? (
                <p className="text-xs text-muted-foreground">
                    {t("account.switcher.full", { max: data.max })}
                </p>
            ) : null}
            {state.confirmElement}
        </div>
    );
}

/** The switcher the account menu opens. Loads when it opens. */
export function AccountSwitcherDialog({
    open,
    onOpenChange
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("nav");
    const state = useDeviceAccounts(open);
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("account.switcher.title")}</DialogTitle>
                    <DialogDescription>{t("account.switcher.description")}</DialogDescription>
                </DialogHeader>
                <DeviceAccountsBody state={state} />
            </DialogContent>
        </Dialog>
    );
}

/** The same list as a section of the sessions page. */
export function DeviceAccountsCard() {
    const t = useTranslations("nav");
    const state = useDeviceAccounts(true);
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="min-w-0">
                    <h2 className="text-sm font-medium">{t("account.switcher.sectionTitle")}</h2>
                    <p className="text-xs text-muted-foreground">
                        {t("account.switcher.description")}
                    </p>
                </div>
                <DeviceAccountsBody state={state} />
            </CardBody>
        </Card>
    );
}
