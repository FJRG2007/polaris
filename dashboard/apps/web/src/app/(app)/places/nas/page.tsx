import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@polaris/db";
import { PageHeader } from "@polaris/ui";
import { grantedSubjects } from "@/lib/access/grants";
import { getTranslations } from "@/lib/i18n/request";
import { homePathForUser, requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Every NAS the reader connected in Drive, and the ones lent to them. */
export default async function NasListPage() {
    const user = await requireUser();
    const lent = [...(await grantedSubjects(user.id, "place.nas")).keys()];
    const [t, rows] = await Promise.all([
        getTranslations("servers"),
        prisma.storageConnection.findMany({
            where: {
                kind: "unifi-unas",
                OR: [{ ownerId: user.id }, ...(lent.length > 0 ? [{ id: { in: lent } }] : [])]
            },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
            take: 100
        })
    ]);
    if (rows.length === 0 && lent.length > 0) redirect(`${await homePathForUser(user)}?denied=1`);
    if (rows.length === 1) redirect(`/places/nas/${rows[0]!.id}`);
    return (
        <>
            <PageHeader title={t("nas.heading")} />
            {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    {t("nas.none")}{" "}
                    <Link href="/drive" className="underline">
                        {t("nas.openDrive")}
                    </Link>
                </p>
            ) : (
                <ul className="flex flex-col divide-y rounded-md border">
                    {rows.map((row) => (
                        <li key={row.id} className="min-w-0">
                            <Link
                                href={`/places/nas/${row.id}`}
                                className="block truncate px-3 py-2 text-sm hover:bg-muted"
                                title={row.name}
                            >
                                {row.name}
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </>
    );
}
