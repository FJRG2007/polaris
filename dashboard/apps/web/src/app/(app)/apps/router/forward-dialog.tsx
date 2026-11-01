"use client";

/** A port open from the internet, added to the draft. */

import { useState } from "react";
import * as ui from "@polaris/ui";
import { isHostOf } from "@/lib/vpn/networks";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { forwardSchema, type RouterForward, type RouterLan } from "@/lib/router/plan";

function portOf(text: string): number {
    return Number(text.replace(/\D/g, ""));
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
        address.trim() !== "" &&
        parsed.success &&
        !lans.some((lan) => isHostOf(lan.cidr, address.trim()));
    const valid = parsed.success && !outside;

    return (
        <ui.Dialog open onOpenChange={(open) => !open && onClose()}>
            <ui.DialogContent>
                <ui.DialogHeader>
                    <ui.DialogTitle>{t("addForward")}</ui.DialogTitle>
                    <ui.DialogDescription>{t("forwardBody")}</ui.DialogDescription>
                </ui.DialogHeader>
                <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                    <ui.Select
                        aria-label={t("protocol")}
                        value={protocol}
                        onValueChange={(value) => setProtocol(value === "udp" ? "udp" : "tcp")}
                        options={[
                            { value: "tcp", label: "TCP" },
                            { value: "udp", label: "UDP" }
                        ]}
                    />
                    <ui.Input
                        aria-label={t("openPort")}
                        placeholder={`${t("openPort")} *`}
                        inputMode="numeric"
                        value={port}
                        onChange={(event) => setPort(event.target.value)}
                    />
                    <ui.Input
                        aria-label={t("toAddress")}
                        placeholder={`${t("toAddress")} *`}
                        className="font-mono"
                        value={address}
                        onChange={(event) => setAddress(event.target.value)}
                    />
                    <ui.Input
                        aria-label={t("toPort")}
                        placeholder={t("toPort")}
                        inputMode="numeric"
                        value={toPort}
                        onChange={(event) => setToPort(event.target.value)}
                    />
                </div>
                {outside ? (
                    <p role="alert" className="text-xs text-danger">
                        {t("problems.outside")}
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
