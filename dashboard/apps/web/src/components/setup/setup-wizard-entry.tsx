"use client";

/**
 * The two ways into the first-run setup.
 *
 * `SetupWizardOffer` sits on the Overview and opens the setup by itself, once per
 * deployment, for the first administrator who arrives there; it asks the server
 * after the page is drawn, so the Overview never waits on it. `SetupWizardPanel`
 * is the same setup on its own page in Management, for opening it again later.
 *
 * Either way, leaving it - finished or skipped - is remembered for every
 * administrator, and the layout is redrawn so newly installed apps are in the
 * app menu straight away.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SetupApp } from "@/lib/setup/setup-wizard";
import { SetupWizard } from "@/components/setup/setup-wizard";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    finishSetupAction,
    setupInstalledAction,
    setupStateAction
} from "@/app/(app)/setup-actions";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@polaris/ui";

export function SetupWizardOffer() {
    const t = useTranslations("setup");
    const router = useRouter();
    const [state, setState] = useState<{ offer: boolean; installed: readonly SetupApp[] | null }>({
        offer: false,
        installed: null
    });
    const [closed, setClosed] = useState(false);
    const [installing, setInstalling] = useState(false);
    const started = useRef(false);

    useEffect(() => {
        let live = true;
        setupStateAction()
            .then(
                (answer) => live && setState({ offer: answer.offer, installed: answer.installed })
            )
            // An offer is not worth an error: without an answer nothing opens.
            .catch(() => live && setState({ offer: false, installed: [] }));
        return () => {
            live = false;
        };
    }, []);

    function onInstalling(busy: boolean) {
        if (busy) started.current = true;
        setInstalling(busy);
    }

    function finish(outcome: "done" | "skipped") {
        setClosed(true);
        void finishSetupAction(outcome).finally(() => router.refresh());
    }

    // Installs under way keep it open; once any has run, leaving it is finishing it.
    function dismiss(open: boolean) {
        if (open || installing) return;
        finish(started.current ? "done" : "skipped");
    }

    return (
        <Dialog open={state.offer && !closed} onOpenChange={dismiss}>
            <DialogContent className="w-[calc(100%-2rem)] max-w-xl" showClose={!installing}>
                <DialogHeader>
                    <DialogTitle>{t("wizard.title")}</DialogTitle>
                    <DialogDescription className="sr-only">{t("wizard.intro")}</DialogDescription>
                </DialogHeader>
                <SetupWizard
                    installed={state.installed}
                    onFinish={finish}
                    onInstalling={onInstalling}
                />
            </DialogContent>
        </Dialog>
    );
}

function useInstalledSetupApps(round: number): readonly SetupApp[] | null {
    const [installed, setInstalled] = useState<readonly SetupApp[] | null>(null);
    useEffect(() => {
        let live = true;
        setupInstalledAction()
            .then((answer) => live && setInstalled(answer))
            // Without an answer the panel lists every app as not installed yet.
            .catch(() => live && setInstalled([]));
        return () => {
            live = false;
        };
    }, [round]);
    return installed;
}

export function SetupWizardPanel() {
    const router = useRouter();
    // Opened again on purpose: a fresh start, and a fresh answer, each time it is left.
    const [round, setRound] = useState(0);
    const installed = useInstalledSetupApps(round);

    function finish(outcome: "done" | "skipped") {
        void finishSetupAction(outcome).finally(() => {
            router.refresh();
            if (outcome === "done") router.push("/home");
            else setRound((value) => value + 1);
        });
    }

    return <SetupWizard key={round} installed={installed} onFinish={finish} />;
}
