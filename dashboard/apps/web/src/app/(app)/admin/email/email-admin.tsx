"use client";

/**
 * The account-mail picker. One choice, so the page is one card - a dropdown of
 * the email channels that exist, plus what happens if none is chosen.
 *
 * A channel whose last check failed is still offered, marked as such: the fix is
 * usually a field on the channel, and forcing the operator to repair it before
 * they can even nominate it would be the wrong order to work in.
 */

import Link from "next/link";
import { useState, useTransition } from "react";
import { MAIL_PROVIDER_INFO } from "@polaris/core";
import { setAuthMailChannelAction } from "./actions";
import type { EmailChannelView } from "@/lib/mail-service";
import { Button, Card, CardBody, PageHeader, Select } from "@polaris/ui";

const NONE = "none";

export function AccountMailView({
    channels,
    selectedId
}: {
    channels: EmailChannelView[];
    selectedId: string | null;
}) {
    const [choice, setChoice] = useState(selectedId ?? NONE);
    const [saved, setSaved] = useState(selectedId ?? NONE);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [saving, startSave] = useTransition();

    const options = [
        { value: NONE, label: "Do not send account mail" },
        ...channels.map((channel) => ({
            value: channel.id,
            label: `${channel.name} - ${MAIL_PROVIDER_INFO[channel.provider].label}${
                channel.status === "connected" ? "" : " (not working)"
            }`
        }))
    ];

    function save() {
        setError(null);
        setNotice(null);
        startSave(async () => {
            const result = await setAuthMailChannelAction(choice === NONE ? null : choice);
            if (result.error) {
                setError(result.error);
                return;
            }
            setSaved(choice);
            setNotice("Saved.");
        });
    }

    return (
        // Narrow page: centre the column in the content area, header included.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title="Account mail"
                description="The email channel Polaris sends account messages through."
            />
            <Card>
                <CardBody className="flex flex-col gap-3">
                    {channels.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            No email channel has been set up yet. Add one under{" "}
                            <Link href="/inbox/channels" className="text-primary hover:underline">
                                Inbox &gt; Channels
                            </Link>
                            , then come back and pick it here.
                        </p>
                    ) : (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">Send through</span>
                                <Select value={choice} onValueChange={setChoice} options={options} />
                            </label>
                            <p className="text-xs text-muted-foreground">
                                Address verification, password resets and emailed sign-in codes all
                                go through this channel. With none chosen, Polaris sends no mail and
                                those are unavailable.
                            </p>
                            {error ? <p className="text-sm text-danger">{error}</p> : null}
                            {notice ? <p className="text-sm text-success">{notice}</p> : null}
                            <div className="flex justify-end">
                                <Button onClick={save} disabled={saving || choice === saved}>
                                    {saving ? "Saving..." : "Save"}
                                </Button>
                            </div>
                        </>
                    )}
                </CardBody>
            </Card>
        </div>
    );
}
