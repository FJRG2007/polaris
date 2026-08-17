/**
 * Home's front page: the cameras, live.
 *
 * The server hands over the frame and nothing else. Every camera on this wall is
 * fetched by the client, so the heading and the buttons are on screen before a
 * single camera has been asked for - which matters here more than anywhere,
 * because a camera that is asleep takes a moment to answer and there is no
 * reason for that to be a moment of blank page.
 */

import Link from "next/link";
import { Plus } from "lucide-react";
import { HouseView } from "./house-view";
import { Button, PageHeader } from "@polaris/ui";
import { requireHomeUser } from "@/lib/home/access";

export const dynamic = "force-dynamic";

export default async function HousePage() {
    const { canManage, canControl } = await requireHomeUser("home.read");

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader title="Live" description="Every camera in the house, and what it can see right now." />
                {canManage ? (
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/house/cameras">
                            <Plus className="size-4 shrink-0" />
                            Add a camera
                        </Link>
                    </Button>
                ) : null}
            </div>
            <HouseView canManage={canManage} canControl={canControl} />
        </div>
    );
}
