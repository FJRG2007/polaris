"use client";

/**
 * What a session is tied to, beyond the cookie itself.
 *
 * A session cookie is a bearer token: it is the account, in whoever's hands it
 * lands. Everything else on this screen guards the moment of signing in - the
 * password, the second factor, the approval - and says nothing at all about the
 * hours afterwards, which is exactly the window a stolen cookie is worth
 * something in. This card is that window.
 *
 * Two settings, and the copy is honest about which one can be wrong. The client
 * binding cannot: a browser update changes a version and never a name, and the
 * one name a browser does rewrite about itself - the system, which any set of
 * developer tools will put a phone's on a laptop - is only acted on when the
 * address changed with it. The address binding can be wrong, and the note on
 * each choice says exactly when.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AddressPinScope } from "@polaris/core";
import { Feedback, type SettingLock } from "./setting-card";
import { updateSessionBindingAction } from "./actions";
import { Button, Card, CardBody, Select, Switch } from "@polaris/ui";
import { ADDRESS_PIN_LABELS, ADDRESS_PIN_NOTES, ADDRESS_PIN_SCOPES } from "@polaris/core";

export function SessionBindingCard({
    bindSessionsToClient,
    pinSessionsToAddress,
    lock
}: {
    bindSessionsToClient: boolean;
    pinSessionsToAddress: AddressPinScope;
    lock?: SettingLock;
}) {
    const router = useRouter();
    const [bindClient, setBindClient] = useState(bindSessionsToClient);
    const [scope, setScope] = useState<AddressPinScope>(pinSessionsToAddress);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ error?: string; ok?: string } | null>(null);
    const locked = Boolean(lock);
    const changed = bindClient !== bindSessionsToClient || scope !== pinSessionsToAddress;

    async function save(): Promise<void> {
        setBusy(true);
        setResult(null);
        const answer = await updateSessionBindingAction({
            bindSessionsToClient: bindClient,
            pinSessionsToAddress: scope
        });
        setBusy(false);
        setResult(answer.error ? answer : { ok: "Saved." });
        if (!answer.error) router.refresh();
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div>
                    <h2 className="text-sm font-medium">Where your sessions may be used</h2>
                    <p className="text-xs text-muted-foreground">
                        A session cookie is whoever holds it. These tie yours to the device and the
                        network they were opened on, so a copy taken somewhere else stops working.
                    </p>
                </div>

                {/* Both settings read the same way round - what it does on the left, the
                    control that changes it on the right - so the eye runs down one column
                    of prose and one column of controls instead of stepping around a
                    full-width dropdown between two rows that are not. */}
                <div className="flex flex-col gap-3">
                    <label className="flex items-start justify-between gap-4">
                        <span className="min-w-0">
                            <span className="block text-sm">Only the browser it was opened in</span>
                            <span className="block text-xs text-muted-foreground">
                                A session used from a different browser is ended and you are told,
                                as is one used from a different operating system somewhere else.
                                Nothing you do normally crosses this: an update changes a version,
                                not a name.
                            </span>
                        </span>
                        <Switch
                            checked={bindClient}
                            disabled={locked}
                            onChange={setBindClient}
                            aria-label="Only the browser it was opened in"
                        />
                    </label>

                    <div className="flex items-start justify-between gap-4">
                        <span className="min-w-0">
                            <span className="block text-sm">Also tie to the network address</span>
                            <span className="block text-xs text-muted-foreground">
                                {ADDRESS_PIN_NOTES[scope]}
                            </span>
                        </span>
                        <Select
                            value={scope}
                            disabled={locked}
                            onValueChange={(value) => setScope(value as AddressPinScope)}
                            aria-label="Also tie to the network address"
                            className="w-44 shrink-0"
                            options={ADDRESS_PIN_SCOPES.map((option) => ({
                                value: option,
                                label: ADDRESS_PIN_LABELS[option]
                            }))}
                        />
                    </div>
                </div>

                {/* The footnote and Save share the last line rather than taking one each:
                    a button alone on a row leaves the width of the card empty beside it. */}
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                        One device can answer differently from this: open Sessions and set it on the
                        session itself.
                    </p>
                    <div className="flex shrink-0 items-center gap-3">
                        <Feedback error={result?.error} ok={result?.ok} />
                        <Button onClick={() => void save()} disabled={locked || busy || !changed}>
                            {busy ? "Saving..." : "Save"}
                        </Button>
                    </div>
                </div>
            </CardBody>
        </Card>
    );
}
