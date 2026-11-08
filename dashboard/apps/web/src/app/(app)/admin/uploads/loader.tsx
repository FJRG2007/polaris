"use client";

import { paintRead } from "../paint-read";
import { UploadsView } from "./uploads-view";
import { CardSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";

export function UploadsLoader({ revision }: { revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin.uploads"
            load={() => paintRead("uploads")}
            revision={revision}
            skeleton={
                <div className="flex flex-col gap-4">
                    <CardSkeleton lines={2} />
                    <CardSkeleton lines={2} />
                    <CardSkeleton lines={2} />
                </div>
            }
        >
            {(data) => (
                <UploadsView
                    uploads={data.uploads}
                    avatars={data.avatars}
                    chat={data.chat}
                    drives={data.drives}
                    orgDrives={data.orgDrives}
                    footage={data.footage}
                    network={data.network}
                />
            )}
        </AfterPaint>
    );
}
