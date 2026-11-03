"use client";

/** A port open from the internet, added to the draft. */

import { useState } from "react";
import * as ui from "@polaris/ui";
import { Field } from "./router-field";
import { firstHost, isHostOf } from "@/lib/vpn/networks";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { forwardSchema, type RouterForward, type RouterLan } from "@/lib/router/plan";

function portOf(text: string): number {
    return Number(text.replace(/\D/g, ""));
}

/** A device address of `cidr` to show as an example: the router's is .1. */
function exampleHost(cidr: string): string {
    const candidate = firstHost(cidr).replace(/\.\d+$/, ".20");
    return isHostOf(cidr, candidate) ? candidate : firstHost(cidr);
}

export function ForwardDialog({
    lans,
    onClose,
    onSave
}: {
    lans: readonly RouterLan[];
    onClose: () => void;
    onSave: (forward: RouterForward) => void;
}) {
    const t = useTranslations("router");
    const [protocol, setProtocol] = useState<"tcp" | "udp">("tcp");
    const [port, setPort] = useState("");
    const [address, setAddress] = useState("");
    const [toPort, setToPort] = useState("");
    const parsed = forwardSchema.safeParse({
        protocol,
        port: portOf(port),
        address,
        toPort: portOf(toPort || port)
    });
    const outside =
        address.trim() !== "" && !lans.some((lan) => isHostOf(lan.cidr, address.trim()));
    const portBad = [port, toPort].some(
        (text) => text.trim() !== "" && !(portOf(text) >= 1 && portOf(text) <= 65535)
    );
    const valid = parsed.success && !outside;
    const example = lans[0] ? exampleHost(lans[0].cidr) : "10.77.0.20";

    return (
        <ui.Dialog open onOpenChange={(open) => !open && onClose()}>
            <ui.DialogContent>
                <ui.DialogHeader>
                    <ui.DialogTitle>{t("addForward")}</ui.DialogTitle>
                    <ui.DialogDescription>{t("forwardBody")}</ui.DialogDescription>
                </ui.DialogHeader>
                <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field id="forward-protocol" label={t("protocol")} hint={t("protocolHint")}>
                        <ui.Select
                            id="forward-protocol"
                            aria-label={t("protocol")}
                            value={protocol}
                            onValueChange={(value) => setProtocol(value === "udp" ? "udp" : "tcp")}
                            options={[
                                { value: "tcp", label: t("tcp") },
                                { value: "udp", label: t("udp") }
                            ]}
                        />
                    </Field>
                    <Field id="forward-port" label={`${t("openPort")} *`} hint={t("openPortHint")}>
                        <ui.Input
                            id="forward-port"
                            className="font-mono"
                            placeholder="443"
                            inputMode="numeric"
                            value={port}
                            onChange={(event) => setPort(event.target.value)}
                        />
                    </Field>
                    <Field
                        id="forward-address"
                        label={`${t("toAddress")} *`}
                        hint={t("toAddressHint", { example: example })}
                    >
                        <ui.Input
                            id="forward-address"
                            className="font-mono"
                            placeholder={example}
                            value={address}
                            onChange={(event) => setAddress(event.target.value)}
                        />
                    </Field>
                    <Field id="forward-to-port" label={t("toPort")} hint={t("toPortHint")}>
                        <ui.Input
                            id="forward-to-port"
                            className="font-mono"
                            placeholder={port || "443"}
                            inputMode="numeric"
                            value={toPort}
                            onChange={(event) => setToPort(event.target.value)}
                        />
                    </Field>
                </div>
                {outside ? (
                    <p role="alert" className="text-xs text-danger">
                        {t("problems.outside")}
                    </p>
                ) : null}
                {portBad ? (
                    <p role="alert" className="text-xs text-danger">
                        {t("badOpenPort")}
                    </p>
                ) : null}
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
