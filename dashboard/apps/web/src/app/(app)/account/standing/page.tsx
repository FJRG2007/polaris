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

import { Suspense } from "react";
import { Card, CardBody } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";
import { requireUser } from "@/lib/session";
import { StandingView } from "./standing-view";
import { PlainNames } from "@/components/person-name";
import { accountStandingFor } from "@/lib/account-standing-service";
import { gameSanctionsFor, offersGameSanctions } from "@/lib/app-extensions/registry";
import { GameSanctionsHeading, GameSanctionsList, GameSanctionsSkeleton } from "./game-sanctions";

export const dynamic = "force-dynamic";

export default async function AccountStandingPage() {
    const session = await requireUser();
    const t = await getTranslations("account");
    // Whether a game-server app is installed is a cached lookup, asked beside
    // the standing so it costs the page nothing; the sanctions themselves are
    // read behind their own boundary.
    const [view, games] = await Promise.all([
        accountStandingFor(session.id),
        offersGameSanctions().catch(() => false)
    ]);

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("standing.page.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("standing.page.intro")}</p>
            </div>
            {/* A record about this account, so it is drawn as one: the face here
                wears no ring and the name no gradient. What the page is telling
                somebody is where they stand with the instance, and a decoration
                across that is the account decorating the notice served on it. */}
            <PlainNames>
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
            </PlainNames>
            {games && (
                <Card>
                    <CardBody className="flex flex-col gap-3">
                        <GameSanctionsHeading />
                        <Suspense fallback={<GameSanctionsSkeleton />}>
                            <GameSanctions userId={session.id} />
                        </Suspense>
                    </CardBody>
                </Card>
            )}
        </div>
    );
}

/** The sanctions game servers put on this account's linked players. Its own
 *  boundary, so the page never waits on it. */
async function GameSanctions({ userId }: { userId: string }) {
    const { sanctions, incomplete } = await gameSanctionsFor(userId).catch((caught: unknown) => {
        console.error("polaris: game sanctions could not be read:", caught);
        return { sanctions: [], incomplete: true };
    });
    return (
        <GameSanctionsList
            incomplete={incomplete}
            sanctions={sanctions.map((sanction) => ({
                id: sanction.id,
                kind: sanction.kind,
                game: sanction.game,
                server: sanction.server,
                player: sanction.player,
                at: sanction.at.toISOString(),
                until: sanction.until ? sanction.until.toISOString() : null,
                active: sanction.active,
                reason: sanction.reason
            }))}
        />
    );
}
