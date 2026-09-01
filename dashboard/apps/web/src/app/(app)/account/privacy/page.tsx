/**
 * Privacy (/account/privacy): what this account shows, and to whom.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { CalendarClock } from "lucide-react";
import { listBlocked } from "@/lib/blocks";
import { Button, Card, CardBody } from "@polaris/ui";
import { requireUser } from "@/lib/session";
import { PrivacyView } from "./privacy-view";
import { BlockedCard } from "./blocked-card";
import { listsFor, namePeople, privacyFor } from "@/lib/privacy-service";

export const dynamic = "force-dynamic";

export default async function PrivacyPage() {
    const session = await requireUser();
    const [settings, lists, blocked] = await Promise.all([
        privacyFor(session.id),
        listsFor(session.id),
        listBlocked(session.id)
    ]);
    // Every name any rule needs, in one read: a row draws the people it names,
    // and it holds their ids.
    const people = await namePeople(core.PRIVACY_FIELDS.flatMap((field) => settings[field].people));

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Privacy</h1>
                <p className="text-sm text-muted-foreground">
                    Who can find you, who sees your details, and who sees what you are doing.
                    Everything here can be answered with everybody, nobody, or a set of people you
                    name.
                </p>
            </div>
            <PrivacyView settings={settings} lists={lists} people={people} />
            {/* The same question by the clock rather than by audience, which is
                why it is on this screen and not beside the display preferences.
                A link rather than the thing itself: it is a list that grows, and
                a screen answering two questions at two lengths reads as one long
                one. */}
            <Card>
                <CardBody className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                    <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-[14rem] flex-1">
                        <span className="block text-[0.8125rem]">Status schedule</span>
                        <span className="block text-[0.6875rem] leading-snug text-foreground-subtle">
                            Hours you are away, busy, or not shown at all, repeated every week.
                        </span>
                    </span>
                    <Button size="sm" variant="secondary" asChild>
                        <Link href="/account/privacy/schedule">Open</Link>
                    </Button>
                </CardBody>
            </Card>
            <BlockedCard people={blocked} />
        </div>
    );
}
