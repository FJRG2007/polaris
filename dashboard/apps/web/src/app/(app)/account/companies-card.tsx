"use client";

/**
 * Where somebody works, on their own profile.
 *
 * Two different claims, and the screen is honest about which is which. The
 * organizations on this Polaris are the ones it can actually vouch for - it
 * holds the roster and this account is on it - so they carry a tick on the
 * profile and are picked here rather than typed. Anything else is a line
 * somebody wrote about themselves, which is what the free field is for and why
 * it is drawn plainly.
 *
 * Nothing is shown until it is marked. Being on a roster is a fact about an
 * organization rather than a statement somebody made about themselves, and an
 * account that joined a company's Polaris did not thereby publish where it
 * works - which is exactly the disclosure a default of "show them all" would
 * have made on everybody's behalf.
 *
 * A person can be in several at once, and show any subset: that is what the
 * checkboxes are, and it is why this is a list rather than the single field it
 * replaced.
 */

import Link from "next/link";
import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { saveCompaniesAction } from "./actions";
import { MAX_COMPANY_LENGTH } from "@polaris/core";
import type { ProfileCompany } from "@/lib/profile-service";
import { BadgeCheck, Building2, ExternalLink } from "lucide-react";
import { Button, Card, CardBody, Checkbox, Input } from "@polaris/ui";

export function CompaniesCard({
    company,
    organizations,
    shown,
    username
}: {
    /** The line they typed, which Polaris knows nothing about. */
    company: string;
    /** Every organization here they belong to, owned or joined. */
    organizations: readonly ProfileCompany[];
    /** The ids of the ones they have chosen to show. */
    shown: readonly string[];
    /** Their handle, for the link to the page all of this ends up on. Empty for
     *  an account that has not taken one, and then there is no page to link to. */
    username: string;
}) {
    const [typed, setTyped] = useState(company);
    const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(shown));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState(false);

    const [savedTyped, setSavedTyped] = useState(company);
    const [savedPicked, setSavedPicked] = useState<readonly string[]>(shown);
    const changed =
        typed.trim() !== savedTyped.trim() ||
        picked.size !== savedPicked.length ||
        savedPicked.some((id) => !picked.has(id));

    const toggle = (id: string) => {
        setDone(false);
        setPicked((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-sm font-medium">Where you work</h2>
                        {username ? (
                            <Link
                                href={`/u/${username}`}
                                className="text-primary flex items-center gap-1 text-xs hover:underline"
                            >
                                See your page
                                <ExternalLink className="size-3 shrink-0" />
                            </Link>
                        ) : null}
                    </div>
                    <p className="text-muted-foreground text-xs">
                        Who sees any of this is one setting on your privacy screen. Nothing here is shown until
                        you tick it.
                    </p>
                </div>

                {organizations.length > 0 ? (
                    <fieldset className="flex flex-col gap-2">
                        <legend className="text-muted-foreground mb-1 text-xs">
                            Organizations here. These carry a tick on your page: Polaris holds the roster and
                            you are on it.
                        </legend>
                        {organizations.map((org) => (
                            <label key={org.id} className="flex items-center gap-2 text-sm">
                                <Checkbox checked={picked.has(org.id)} onChange={() => toggle(org.id)} />
                                <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate" title={org.name}>{org.name}</span>
                                {picked.has(org.id) ? (
                                    <BadgeCheck className="text-primary size-3.5 shrink-0" aria-hidden />
                                ) : null}
                            </label>
                        ))}
                    </fieldset>
                ) : null}

                <label className="flex flex-col gap-1 text-sm">
                    Somewhere else
                    <Input
                        value={typed}
                        placeholder="Optional"
                        maxLength={MAX_COMPANY_LENGTH}
                        autoComplete="organization"
                        onChange={(event) => {
                            setDone(false);
                            setTyped(event.target.value);
                        }}
                    />
                    <span className="text-muted-foreground text-xs">
                        Drawn without a tick, because Polaris knows nothing about it beyond that you typed it.
                    </span>
                </label>

                <div className="flex items-center justify-between gap-2">
                    {error ? <p className="text-danger text-sm">{error}</p> : null}
                    {done && !error ? <p className="text-success text-sm">Saved.</p> : null}
                    <Button
                        type="button"
                        className="ml-auto"
                        disabled={busy || !changed}
                        onClick={async () => {
                            setBusy(true);
                            setError("");
                            setDone(false);
                            const ids = [...picked];
                            const result = await runAction(
                                () => saveCompaniesAction({ company: typed, organizationIds: ids }),
                                setError
                            );
                            setBusy(false);
                            if (!result || result.error) {
                                if (result?.error) setError(result.error);
                                return;
                            }
                            setSavedTyped(typed);
                            setSavedPicked(ids);
                            setDone(true);
                        }}
                    >
                        {busy ? "Saving..." : "Save"}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
