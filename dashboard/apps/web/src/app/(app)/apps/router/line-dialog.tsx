"use client";

/** How one line reaches the internet, changed in the draft: nothing reaches the machine
 *  until Apply. A password left blank keeps the one the machine already has. */

import { useState } from "react";
import * as ui from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    modeOf,
    newLanId,
    staticLineFits,
    wanSchema,
    WAN_MODES,
    type RouterWan,
    type WanMode
} from "@/lib/router/plan";

export function LineDialog({
    wan,
    onClose,
    onSave
}: {
    wan: RouterWan;
    onClose: () => void;
    onSave: (wan: RouterWan) => void;
}) {
    const t = useTranslations("router");
    const [mode, setMode] = useState<WanMode>(modeOf(wan));
    const [address, setAddress] = useState(wan.address ?? "");
    const [gateway, setGateway] = useState(wan.gateway ?? "");
    const [username, setUsername] = useState(wan.username ?? "");
    const [password, setPassword] = useState("");
    const hasPassword = Boolean(wan.username);

    const fixed = { address: address.trim(), gateway: gateway.trim() };
    const fixedBad = fixed.address !== "" && fixed.gateway !== "" && !staticLineFits(fixed);
    const candidate: RouterWan =
        mode === "dhcp"
            ? { interface: wan.interface, vlan: wan.vlan }
            : mode === "static"
              ? { interface: wan.interface, vlan: wan.vlan, mode, ...fixed }
              : {
                    interface: wan.interface,
                    vlan: wan.vlan,
                    mode,
                    id: wan.id ?? newLanId(),
                    username,
                    ...(password || wan.password ? { password: password || wan.password } : {})
                };
    const parsed = wanSchema.safeParse(candidate);
    const complete =
        mode === "dhcp" ||
        (mode === "static" && staticLineFits(fixed)) ||
        (mode === "pppoe" && username.trim() !== "" && (password !== "" || hasPassword));
    const valid = parsed.success && complete;

    return (
        <ui.Dialog open onOpenChange={(open) => !open && onClose()}>
            <ui.DialogContent>
                <ui.DialogHeader>
                    <ui.DialogTitle>{t("editLine")}</ui.DialogTitle>
                    <ui.DialogDescription>{t("lineBody")}</ui.DialogDescription>
                </ui.DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    <ui.Select
                        aria-label={t("lineMode")}
                        value={mode}
                        onValueChange={(next) => setMode(next as WanMode)}
                        options={WAN_MODES.map((value) => ({
                            value,
                            label: t(`lineModes.${value}`)
                        }))}
                    />
                    {mode === "static" ? (
                        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                            <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
                                {`${t("lineAddress")} *`}
                                <ui.Input
                                    className="font-mono"
                                    placeholder="203.0.113.2/29"
                                    value={address}
                                    onChange={(event) => setAddress(event.target.value)}
                                />
                            </label>
                            <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
                                {`${t("lineGateway")} *`}
                                <ui.Input
                                    className="font-mono"
                                    placeholder="203.0.113.1"
                                    value={gateway}
                                    onChange={(event) => setGateway(event.target.value)}
                                />
                            </label>
                            {fixedBad ? (
                                <p role="alert" className="text-xs text-danger sm:col-span-2">
                                    {t("problems.badStaticLine")}
                                </p>
                            ) : null}
                        </div>
                    ) : null}
                    {mode === "pppoe" ? (
                        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                            <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
                                {`${t("lineUser")} *`}
                                <ui.Input
                                    autoComplete="off"
                                    value={username}
                                    maxLength={128}
                                    onChange={(event) => setUsername(event.target.value)}
                                />
                            </label>
                            <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
                                {/* enigma:allow-no-breach-check - the provider's own, not one chosen here */}
                                {hasPassword ? t("linePassword") : `${t("linePassword")} *`}
                                <ui.Input
                                    type="password"
                                    autoComplete="new-password"
                                    placeholder={hasPassword ? t("keepPassword") : undefined}
                                    value={password}
                                    maxLength={128}
                                    onChange={(event) => setPassword(event.target.value)}
                                />
                            </label>
                        </div>
                    ) : null}
                </div>
                <ui.DialogFooter>
                    <ui.Button variant="ghost" size="sm" onClick={onClose}>
                        {t("cancel")}
                    </ui.Button>
                    <ui.Button
                        size="sm"
                        aria-disabled={!valid}
                        onClick={() => parsed.success && valid && onSave(parsed.data)}
                    >
                        {t("save")}
                    </ui.Button>
                </ui.DialogFooter>
            </ui.DialogContent>
        </ui.Dialog>
    );
}
