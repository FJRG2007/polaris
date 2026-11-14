"use client";

/**
 * The switches a connected account can be changed by once it is connected
 * (`ConnectionOption`), each with what it does in a line under it.
 *
 * A switch flips at once and is put back, with the reason, when the server
 * refuses it. Nothing here signs in: only the setting is stored.
 */

import { useState } from "react";
import * as actions from "../actions";
import { usePlacesT } from "../use-places-t";
import type { PlacesKey } from "../../../messages";
import * as registry from "../../lib/device-connections";
import { placesRefusalText } from "../../lib/refusal-text";
import type { DeviceAccountView } from "../../lib/device-accounts";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Switch,
    useOptimisticToggle
} from "@polaris/ui";

export function AccountOptionsDialog({
    account,
    onClose,
    onChanged
}: {
    /** The account being changed, or null while the dialog is closed. */
    account: DeviceAccountView | null;
    onClose: () => void;
    /** Told the account as it is now: at once, and again if it is put back. */
    onChanged: (account: DeviceAccountView) => void;
}) {
    const t = usePlacesT();
    const [error, setError] = useState<string | null>(null);
    const options = account ? (registry.deviceConnection(account.connection)?.options ?? []) : [];

    return (
        <Dialog
            open={account !== null}
            onOpenChange={(open) => {
                if (open) return;
                setError(null);
                onClose();
            }}
        >
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {t("devicesView.accountSettings", { name: account?.label ?? "" })}
                    </DialogTitle>
                    <DialogDescription>{account?.connectionLabel ?? ""}</DialogDescription>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-4">
                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {placesRefusalText(t, error)}
                        </p>
                    )}
                    {account
                        ? options.map((option) => {
                              const base = `connections.${account.connection}.options.${option.key}`;
                              const label = t(`${base}.label` as PlacesKey);
                              const hintId = `account-option-${option.key}`;
                              return (
                                  <div key={option.key} className="flex min-w-0 items-start gap-3">
                                      <div className="min-w-0 flex-1">
                                          <p className="text-sm font-medium">{label}</p>
                                          <p
                                              id={hintId}
                                              className="mt-0.5 text-xs text-muted-foreground"
                                          >
                                              {t(`${base}.hint` as PlacesKey)}
                                          </p>
                                      </div>
                                      <OptionSwitch
                                          account={account}
                                          optionKey={option.key}
                                          on={account.options[option.key] ?? option.defaultOn}
                                          label={label}
                                          hintId={hintId}
                                          onChanged={onChanged}
                                          onError={setError}
                                      />
                                  </div>
                              );
                          })
                        : null}
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** One option's switch: it moves at once, and goes back with the reason if the
 *  server refuses. Its own hook, so two options saved together never wait on, or
 *  undo, each other. */
function OptionSwitch({
    account,
    optionKey,
    on,
    label,
    hintId,
    onChanged,
    onError
}: {
    account: DeviceAccountView;
    optionKey: string;
    on: boolean;
    label: string;
    hintId: string;
    onChanged: (account: DeviceAccountView) => void;
    onError: (message: string | null) => void;
}) {
    const t = usePlacesT();
    const [checked, setChecked] = useOptimisticToggle(
        on,
        async (next) => {
            onError(null);
            const answer = await actions
                .setDeviceAccountOptionAction({ accountId: account.id, key: optionKey, on: next })
                .catch(() => ({ error: t("actions.someWrong") }) as { error: string });
            if (answer.error || !("account" in answer) || !answer.account)
                return { error: answer.error ?? t("actions.someWrong") };
            onChanged(answer.account);
            return answer;
        },
        { onRefused: onError }
    );
    return (
        <Switch
            checked={checked}
            aria-label={label}
            aria-describedby={hintId}
            onChange={setChecked}
        />
    );
}
