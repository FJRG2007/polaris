"use client";

/**
 * How much of each mailbox Polaris keeps the words of.
 *
 * It belongs on this screen rather than under Mail because it is not a
 * preference anybody reading their mail has: it is disk. A synced message is an
 * envelope and costs a few hundred bytes; the message itself is the newsletter,
 * the quoted thread, the signature image referenced twice - and holding every
 * one of them for every mailbox is how a server fills up without anybody having
 * done anything.
 *
 * Zero is offered deliberately. A deployment whose mail server is on the same
 * LAN answers in a millisecond, so there is nothing for a held copy to save; one
 * short of disk would rather spend the second.
 */

import { runAction } from "@/lib/run-action";
import { MAIL_BODY_KEEP_MAX } from "@polaris/core";
import { useEffect, useState, useTransition } from "react";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { mailBodyHeldAction, saveMailBodyKeepAction } from "./actions";
import { writeSnapshot } from "@/lib/snapshot-cache";
import { useKeptSnapshot } from "@/components/use-live-resource";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** Where the last count is kept, and how old it may be and still be shown. */
const HELD_KEY = "retention:mail-held";
const KEPT_MAX_AGE_MS = 24 * 3_600_000;

/** What the card says about the count while it is still being read, and when it
 *  could not be. Neither is an error worth the form's own error line: the
 *  setting above is editable and savable whether or not this number arrives. */
function heldLine(t: NamespaceTranslator<"admin">, held: number | null, failed: boolean): string {
    if (failed) return t("retention.mail.held.failed");
    if (held === null) return t("retention.mail.held.counting");
    if (held === 0) return t("retention.mail.held.none");
    return t("retention.mail.held.some", { count: held, held: held.toLocaleString() });
}

export function MailBodyForm({ kept }: { kept: number }) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const [value, setValue] = useState(String(kept));
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [pending, startTransition] = useTransition();
    // Read here rather than handed down by the page: counting held bodies is a
    // scan of the whole message table, and awaited on the server it stood
    // between somebody and this screen. The card is up immediately and the
    // number follows.
    // The count last read is shown at once, and replaced when the scan lands.
    const [held, setHeld] = useState<number | null>(null);
    const [countFailed, setCountFailed] = useState(false);
    useKeptSnapshot<number>(HELD_KEY, KEPT_MAX_AGE_MS, ({ value }) =>
        setHeld((current) => current ?? value)
    );

    useEffect(() => {
        void runAction(
            () => mailBodyHeldAction(),
            () => setCountFailed(true)
        ).then((result) => {
            if (!result) return;
            setHeld(result.held);
            writeSnapshot(HELD_KEY, result.held);
        });
    }, []);

    const parsed = Number.parseInt(value, 10);
    const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= MAIL_BODY_KEEP_MAX;
    // Dirty means it differs from what is stored, not that somebody typed in it.
    const dirty = valid && parsed !== kept;

    function save() {
        setError(null);
        setSaved(false);
        startTransition(async () => {
            const result = await saveMailBodyKeepAction(parsed);
            if (result.error) {
                setError(result.error);
                return;
            }
            setSaved(true);
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-medium">{t("retention.mail.title")}</h2>
                    <p className="max-w-xl text-sm text-muted-foreground">{t("retention.mail.intro")}</p>
                </div>

                <label className="flex max-w-[12rem] flex-col gap-1 text-sm">
                    <span className="font-medium">
                        {t("retention.mail.label")} <span aria-hidden="true">*</span>
                    </span>
                    <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={MAIL_BODY_KEEP_MAX}
                        value={value}
                        aria-label={t("retention.mail.ariaLabel")}
                        aria-invalid={value.trim() !== "" && !valid}
                        onChange={(event) => setValue(event.target.value)}
                    />
                    <span className="text-xs text-muted-foreground">
                        {parsed === 0 && valid ? t("retention.mail.zeroHint") : t("retention.mail.hint")}
                    </span>
                </label>

                <p className="text-sm text-muted-foreground">{heldLine(t, held, countFailed)}</p>

                {error && <p className="text-sm text-danger">{error}</p>}
                {saved && !dirty && <p className="text-sm text-muted-foreground">{t("retention.mail.saved")}</p>}

                <Button
                    className="self-start"
                    size="sm"
                    disabled={!dirty || pending}
                    onClick={save}
                >
                    {tc("actions.save")}
                </Button>
            </CardBody>
        </Card>
    );
}
