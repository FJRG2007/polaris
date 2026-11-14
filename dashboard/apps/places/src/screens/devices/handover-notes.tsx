"use client";

/**
 * What changed hands, said above the list: devices that moved from one of this
 * house's connections to another with everything kept, a connection left with
 * nothing (and the button that removes it), and devices that left the house -
 * marked, never quietly deleted, with the choice of restoring one that came back.
 */

import { useState } from "react";
import { Button } from "@polaris/ui";
import { usePlacesT } from "../use-places-t";
import type { DeviceView } from "../../lib/device-kinds";
import type { DeviceAccountView } from "../../lib/device-accounts";

export function HandoverNotes({
    accounts,
    canManage,
    onRemove
}: {
    accounts: readonly DeviceAccountView[];
    canManage: boolean;
    onRemove: (account: DeviceAccountView) => void;
}) {
    const t = usePlacesT();
    const notes = accounts.flatMap((account) => [
        ...(account.movedIn ?? []).map((move) => (
            <p
                key={`${account.id}-${move.from}`}
                role="status"
                className="rounded-lg border border-border bg-card px-3 py-2 text-sm"
            >
                {t("devicesView.movedIn", {
                    count: move.count,
                    from: move.from,
                    to: account.connectionLabel
                })}
            </p>
        )),
        ...(account.movedOut
            ? [
                  <div
                      key={`${account.id}-out`}
                      className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
                  >
                      <p className="min-w-0 flex-1 text-sm">
                          {t("devicesView.movedOut", {
                              from: account.connectionLabel,
                              to: account.movedOut.to
                          })}
                      </p>
                      {canManage && (
                          <Button size="sm" variant="outline" onClick={() => onRemove(account)}>
                              {t("devicesView.removeEmpty", { name: account.label })}
                          </Button>
                      )}
                  </div>
              ]
            : [])
    ]);
    return notes.length > 0 ? <>{notes}</> : null;
}

export function GoneDevices({
    devices,
    canManage,
    onSettle
}: {
    devices: readonly DeviceView[];
    canManage: boolean;
    onSettle: (device: DeviceView, choice: "restore" | "forget") => Promise<void>;
}) {
    const t = usePlacesT();
    const [working, setWorking] = useState<string | null>(null);
    if (devices.length === 0) return null;
    const settle = async (device: DeviceView, choice: "restore" | "forget") => {
        setWorking(device.id);
        try {
            await onSettle(device, choice);
        } finally {
            setWorking(null);
        }
    };
    return (
        <section className="flex flex-col gap-2">
            <h2 className="text-xs font-medium text-muted-foreground">
                {t("devicesView.goneTitle")}
            </h2>
            <ul className="flex flex-col gap-2">
                {devices.map((device) => (
                    <li
                        key={device.id}
                        className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
                    >
                        <div className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-sm font-medium" title={device.name}>
                                {device.name}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {device.gone === "back"
                                    ? t("devicesView.goneBack")
                                    : t("devicesView.goneAway")}
                            </span>
                        </div>
                        {canManage && device.gone === "back" && (
                            <Button
                                size="sm"
                                disabled={working === device.id}
                                onClick={() => void settle(device, "restore")}
                            >
                                {t("devicesView.goneRestore")}
                            </Button>
                        )}
                        {canManage && (
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={working === device.id}
                                onClick={() => void settle(device, "forget")}
                            >
                                {device.gone === "back"
                                    ? t("devicesView.goneFresh")
                                    : t("devicesView.goneRemove")}
                            </Button>
                        )}
                    </li>
                ))}
            </ul>
        </section>
    );
}
