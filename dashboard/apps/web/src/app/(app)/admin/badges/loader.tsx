"use client";

import { loadInstanceTagAction } from "./data";
import { CardSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";
import { InstanceNameTag } from "./instance-name-tag";

export function InstanceNameTagLoader({ revision }: { revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin-instance-tag"
            load={loadInstanceTagAction}
            revision={revision}
            skeleton={<CardSkeleton lines={2} />}
        >
            {(tag) => <InstanceNameTag initial={tag} />}
        </AfterPaint>
    );
}
