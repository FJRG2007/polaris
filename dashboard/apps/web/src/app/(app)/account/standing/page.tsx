/**
 * Account standing (/account/standing): where this account stands with the
 * instance, and anything in force against it right now.
 *
 * It exists because of what it looks like not to have it. Moderation is
 * invisible until the moment it is total: somebody has a message taken down and
 * is told nothing, then one day cannot sign in. A page that says where they are
 * before that happens is the difference between a rule and an ambush - and it
 * costs nothing, because everything on it was already written down.
 *
 * Nothing here is settable. It is a record, and the only thing that moves it is
 * a moderator's decision.
 */

import { requireUser } from "@/lib/session";
import { StandingView } from "./standing-view";
import { accountStandingFor } from "@/lib/account-standing-service";

export const dynamic = "force-dynamic";

export default async function AccountStandingPage() {
    const session = await requireUser();
    const view = await accountStandingFor(session.id);

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Account standing</h1>
                <p className="text-sm text-muted-foreground">
                    Where your account stands here, and anything in force against it.
                </p>
            </div>
            <StandingView
                person={{ id: session.id, name: session.name }}
                standing={view.standing}
                upheld={view.upheld}
                since={view.since.toISOString()}
                restrictions={view.restrictions.map((restriction) => ({
                    kind: restriction.kind,
                    where: restriction.where,
                    until: restriction.until ? restriction.until.toISOString() : null
                }))}
            />
        </div>
    );
}
