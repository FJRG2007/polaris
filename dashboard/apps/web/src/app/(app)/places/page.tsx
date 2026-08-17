/**
 * The front page of a place: its cameras, live.
 *
 * The server hands over the frame and nothing else. Every camera on this wall is
 * fetched by the client, so the heading and the buttons are on screen before a
 * single camera has been asked for - which matters here more than anywhere,
 * because a camera that is asleep takes a moment to answer and there is no
 * reason for that to be a moment of blank page.
 */

import Link from "next/link";
import { Plus } from "lucide-react";
import { Wall } from "./wall";
import { Button, PageHeader } from "@polaris/ui";
import { requireHomeUser } from "@/lib/home/access";
import { currentPlace } from "@/lib/home/current-place";
import { PlaceSwitcher } from "./place-switcher";

export const dynamic = "force-dynamic";

export default async function PlacePage() {
    const { install, canManage, canControl } = await requireHomeUser("home.read");
    const place = await currentPlace(install.id);

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader
                    title={place.current.name}
                    description="Every camera here, and what it can see right now."
                />
                <div className="flex flex-wrap items-center gap-2">
                    <PlaceSwitcher places={place.places} current={place.current} canManage={canManage} />
                {canManage ? (
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/places/cameras">
                            <Plus className="size-4 shrink-0" />
                            Add a camera
                        </Link>
                    </Button>
                ) : null}
                </div>
            </div>
            <Wall canManage={canManage} canControl={canControl} />
        </div>
    );
}
