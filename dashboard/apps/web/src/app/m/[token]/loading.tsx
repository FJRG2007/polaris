/**
 * What somebody sees between following a call link and finding out whether it
 * is still good.
 *
 * The lookup is a database read on a page reached from outside Polaris, often
 * from a chat client on a phone, and without a boundary here the router holds
 * whatever they were looking at until it answers - which reads as the link
 * having done nothing. This commits the navigation at once and streams the
 * answer into it.
 *
 * Shaped like the card that is about to arrive, rather than a spinner, so the
 * page does not jump when it does.
 */

import { PublicShell } from "@/components/public-shell";
import { Card, CardBody, CardHeader, Skeleton } from "@polaris/ui";

export default function GuestMeetingLoading() {
    return (
        <PublicShell>
            <Card>
                <CardHeader>
                    <Skeleton className="h-5 w-40" />
                </CardHeader>
                <CardBody>
                    <div className="flex flex-col gap-3" aria-hidden="true">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-2/3" />
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-28" />
                    </div>
                </CardBody>
            </Card>
        </PublicShell>
    );
}
