/**
 * Who this account is, before anything about what it may do.
 *
 * The record below this answers "what can this person reach and how do I stop
 * them", which is what an administrator opens the page for - and it answered it
 * with a name and an email address at the top and nothing else. The questions
 * that come first in practice are plainer than that: is this the right person,
 * where do they work, which addresses are theirs, what did they sign in with.
 * Every one of them was somewhere else or nowhere.
 *
 * So the top of the page is a card of facts. It changes nothing and offers no
 * control: the controls are under it, and mixing the two is how a screen ends up
 * with a destructive button beside a line of read-only text.
 *
 * A server component, because all of it is a read and none of it is waiting on
 * anything - and because the connected accounts are provider rows that must not
 * travel to a browser with their tokens attached.
 */

import { prisma } from "@polaris/db";
import { Avatar } from "@/components/avatar";
import { RelativeTime } from "@/components/relative-time";
import { Badge, Card, CardBody } from "@polaris/ui";
import { CONNECTION_PROVIDERS } from "@polaris/core";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceTranslator } from "@/lib/i18n/types";

/** One label and its value. Absent values are left out rather than drawn as a
 *  dash: a card of dashes says nothing and takes the height of one that does. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="break-words text-sm">{children}</span>
        </div>
    );
}

/** What a provider is called, in the words the rest of Polaris uses for it. */
function providerName(t: NamespaceTranslator<"admin">, providerId: string): string {
    const known = CONNECTION_PROVIDERS.find((provider) => provider.slug === providerId);
    if (known) return known.name;
    // "credential" is better-auth's word for a password, which is not a
    // connection at all - and the only other thing this column ever holds.
    return providerId === "credential" ? t("usersDetail.identity.password") : providerId;
}

export async function IdentityCard({ userId }: { userId: string }) {
    const t = await getTranslations("admin");
    const [user, memberships, accounts, ownedOrgs] = await Promise.all([
        prisma.user.findUnique({
            where: { id: userId },
            select: {
                name: true,
                firstName: true,
                lastName: true,
                username: true,
                email: true,
                emailVerified: true,
                company: true,
                headline: true,
                pronouns: true,
                createdAt: true,
                twoFactorEnabled: true
            }
        }),
        prisma.organizationMember.findMany({
            where: { userId },
            orderBy: { createdAt: "asc" },
            select: { role: true, org: { select: { id: true, name: true } } }
        }),
        // The tokens are deliberately not selected. What this card says is which
        // services an account can be signed in with, and nothing that could sign
        // in with them.
        prisma.account.findMany({
            where: { userId },
            orderBy: { createdAt: "asc" },
            select: { providerId: true, createdAt: true }
        }),
        prisma.organization.findMany({
            where: { ownerId: userId },
            orderBy: { name: "asc" },
            select: { id: true, name: true }
        })
    ]);
    if (!user) return null;

    const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
    // An organization somebody owns but is not a member of would otherwise be
    // missing from a card whose whole job is to say where they belong.
    const orgs = [
        ...ownedOrgs.map((org) => ({ id: org.id, name: org.name, role: "owner" })),
        ...memberships
            .filter((row) => !ownedOrgs.some((org) => org.id === row.org.id))
            .map((row) => ({ id: row.org.id, name: row.org.name, role: row.role }))
    ];

    return (
        <Card>
            <CardBody className="flex flex-col gap-5 sm:flex-row sm:gap-6">
                <div className="flex shrink-0 items-start">
                    <Avatar person={{ id: userId, name: user.name }} size={72} status={false} />
                </div>

                <div className="grid min-w-0 flex-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    <Fact label={t("usersDetail.identity.name")}>{user.name}</Fact>
                    {fullName && fullName !== user.name && (
                        <Fact label={t("usersDetail.identity.fullName")}>{fullName}</Fact>
                    )}
                    {user.username && <Fact label={t("usersDetail.identity.handle")}>@{user.username}</Fact>}
                    {user.pronouns && <Fact label={t("usersDetail.identity.pronouns")}>{user.pronouns}</Fact>}

                    <Fact label={t("usersDetail.identity.email")}>
                        <span className="flex flex-wrap items-center gap-1.5">
                            {user.email}
                            {user.emailVerified ? (
                                <Badge variant="success">{t("usersDetail.identity.verified")}</Badge>
                            ) : (
                                <Badge variant="warning">{t("usersDetail.identity.unverified")}</Badge>
                            )}
                        </span>
                    </Fact>

                    {user.company && <Fact label={t("usersDetail.identity.company")}>{user.company}</Fact>}
                    {user.headline && <Fact label={t("usersDetail.identity.headline")}>{user.headline}</Fact>}

                    <Fact label={t("usersDetail.identity.joined")}>
                        <RelativeTime iso={user.createdAt.toISOString()} />
                    </Fact>
                    <Fact label={t("usersDetail.identity.secondFactor")}>
                        {user.twoFactorEnabled ? t("usersDetail.identity.on") : t("usersDetail.identity.off")}
                    </Fact>

                    <Fact label={t("usersDetail.identity.organizations")}>
                        {orgs.length === 0 ? (
                            <span className="text-muted-foreground">{t("usersDetail.identity.none")}</span>
                        ) : (
                            <span className="flex flex-wrap gap-1.5">
                                {orgs.map((org) => (
                                    <Badge key={org.id} variant="neutral">
                                        {t("usersDetail.identity.org", { name: org.name, role: org.role })}
                                    </Badge>
                                ))}
                            </span>
                        )}
                    </Fact>

                    <Fact label={t("usersDetail.identity.signsInWith")}>
                        {accounts.length === 0 ? (
                            <span className="text-muted-foreground">{t("usersDetail.identity.nothingRecorded")}</span>
                        ) : (
                            <span className="flex flex-wrap gap-1.5">
                                {accounts.map((account, index) => (
                                    <Badge key={`${account.providerId}-${index}`} variant="neutral">
                                        {providerName(t, account.providerId)}
                                    </Badge>
                                ))}
                            </span>
                        )}
                    </Fact>
                </div>
            </CardBody>
        </Card>
    );
}
