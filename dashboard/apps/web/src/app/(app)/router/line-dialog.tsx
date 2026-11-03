"use client";

/** How one line reaches the internet, changed in the draft: nothing reaches the machine
 *  until Apply. A password left blank keeps the one the machine already has. */

import { useState } from "react";
import * as ui from "@polaris/ui";
import { Field, VlanField } from "./router-field";
import { vlanError, vlanTakenBy, type PortLink } from "@/lib/router/assist";
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
    position,
    isNew,
    ports,
    links,
    onClose,
    onSave
}: {
    wan: RouterWan;
    /** Its place in the failover order, from 0. */
    position: number;
    isNew: boolean;
    ports: readonly string[];
    /** Every line and network of the draft, to name a port clash as it happens. */
    links: readonly PortLink[];
    onClose: () => void;
    onSave: (wan: RouterWan) => void;
}) {
    const t = useTranslations("router");
    const [port, setPort] = useState(wan.interface);
    const [vlan, setVlan] = useState(wan.vlan);
    const self = { kind: "line" as const, key: String(position) };
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
            ? { interface: port, vlan }
            : mode === "static"
              ? { interface: port, vlan, mode, ...fixed }
              : {
                    interface: port,
                    vlan,
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
    const clash = vlanTakenBy(links, self, port, vlan) !== null;
    const valid = parsed.success && complete && vlanError(vlan) === null && !clash;

    return (
        <ui.Dialog open onOpenChange={(open) => !open && onClose()}>
            <ui.DialogContent>
                <ui.DialogHeader>
                    <ui.DialogTitle>
                        {isNew ? t("addLineTitle") : t("lineTitle", { n: position + 1 })}
                    </ui.DialogTitle>
                    <ui.DialogDescription>{t("lineBody")}</ui.DialogDescription>
                </ui.DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    <Field id="line-port" label={`${t("port")} *`} hint={t("linePortHint")}>
                        <ui.Select
                            id="line-port"
                            aria-label={t("port")}
                            value={port}
                            onValueChange={setPort}
                            options={ports.map((one) => ({ value: one, label: one }))}
                        />
                    </Field>
                    <VlanField
                        id="line-vlan"
                        port={port}
                        value={vlan}
                        links={links}
                        self={self}
                        hint={t("lineVlanHint")}
                        onChange={setVlan}
                    />
                    <Field id="line-mode" label={t("lineMode")} hint={t("lineModeHint")}>
                        <ui.Select
                            id="line-mode"
                            aria-label={t("lineMode")}
                            value={mode}
                            onValueChange={(next) => setMode(next as WanMode)}
                            options={WAN_MODES.map((value) => ({
                                value,
                                label: t(`lineModes.${value}`)
                            }))}
                        />
                    </Field>
                    {mode === "static" ? (
                        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                            <Field
                                id="line-address"
                                label={`${t("lineAddress")} *`}
                                hint={t("lineAddressHint")}
                            >
                                <ui.Input
                                    id="line-address"
                                    className="font-mono"
                                    placeholder="203.0.113.2/29"
                                    value={address}
                                    onChange={(event) => setAddress(event.target.value)}
                                />
                            </Field>
                            <Field
                                id="line-gateway"
                                label={`${t("lineGateway")} *`}
                                hint={t("lineGatewayHint")}
                            >
                                <ui.Input
                                    id="line-gateway"
                                    className="font-mono"
                                    placeholder="203.0.113.1"
                                    value={gateway}
                                    onChange={(event) => setGateway(event.target.value)}
                                />
                            </Field>
                            {fixedBad ? (
                                <p role="alert" className="text-xs text-danger sm:col-span-2">
                                    {t("problems.badStaticLine")}
                                </p>
                            ) : null}
                        </div>
                    ) : null}
                    {mode === "pppoe" ? (
                        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                            <Field
                                id="line-user"
                                label={`${t("lineUser")} *`}
                                hint={t("lineUserHint")}
                            >
                                <ui.Input
                                    id="line-user"
                                    autoComplete="off"
                                    value={username}
                                    maxLength={128}
                                    onChange={(event) => setUsername(event.target.value)}
                                />
                            </Field>
                            <Field
                                id="line-password"
                                label={hasPassword ? t("linePassword") : `${t("linePassword")} *`}
                            >
                                {/* enigma:allow-no-breach-check - the provider's own, not one chosen here */}
                                <ui.Input
                                    id="line-password"
                                    type="password"
                                    autoComplete="new-password"
                                    placeholder={hasPassword ? t("keepPassword") : undefined}
                                    value={password}
                                    maxLength={128}
                                    onChange={(event) => setPassword(event.target.value)}
                                />
                            </Field>
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
