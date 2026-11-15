import type { Metadata } from "next";
import { PAGE_FILL, cn } from "@polaris/ui";
import { redirect } from "next/navigation";
import { polarAccessFor } from "@/lib/polar/access";
import { getTranslations } from "@/lib/i18n/request";
import { homePathForUser, requireUser, userHasManage } from "@/lib/session";
import { SessionBoard } from "@/components/polar/code-board/session-board";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("polar");
    return { title: t("board.title") };
}

/** Polar Code's sessions as a board, one column per whose turn it is. Only
 *  the access is settled here; the sessions are read by the board itself, so
 *  the page draws before they arrive. */
export default async function PolarBoardPage() {
    const user = await requireUser();
    if (!(await polarAccessFor(user.id)).use) redirect(await homePathForUser(user));
    const [canRead, canStart] = await Promise.all([
        userHasManage(user, "agents.read"),
        userHasManage(user, "agents.manage")
    ]);
    return (
        <div className={cn(PAGE_FILL, "flex min-w-0 flex-col")}>
            <SessionBoard canRead={canRead} canStart={canStart} viewerId={user.id} />
        </div>
    );
}
