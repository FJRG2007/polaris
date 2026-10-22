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
    Switch
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
    const [saving, setSaving] = useState<string | null>(null);
    const options = account ? (registry.deviceConnection(account.connection)?.options ?? []) : [];

    const flip = async (key: string, on: boolean) => {
        if (!account || saving) return;
        const before = account;
        setError(null);
        setSaving(key);
        onChanged({ ...account, options: { ...account.options, [key]: on } });
        const answer = await actions
            .setDeviceAccountOptionAction({ accountId: account.id, key, on })
            .catch(() => ({ error: t("actions.someWrong") }) as { error: string });
        setSaving(null);
        if (answer.error || !("account" in answer) || !answer.account) {
            onChanged(before);
            setError(answer.error ?? t("actions.someWrong"));
            return;
        }
        onChanged(answer.account);
    };

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
                                      <Switch
                                          checked={account.options[option.key] ?? option.defaultOn}
                                          disabled={saving !== null}
                                          aria-label={label}
                                          aria-describedby={hintId}
                                          onChange={(on) => void flip(option.key, on)}
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
