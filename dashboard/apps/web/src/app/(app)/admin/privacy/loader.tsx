"use client";

import { loadPrivacyAction } from "./data";
import type { PrivacyData } from "./read";
import { CardSkeleton } from "../region-skeletons";
import { PrivacySections } from "./privacy-sections";
import { AfterPaint } from "@/components/after-paint";
import { PublicProfilesForm } from "./public-profiles-form";
import { PeopleDiscoveryForm } from "./people-discovery-form";

/** The privacy settings, asked for after the headings have painted. */
export function PrivacyLoader({
    revision,
    streamed
}: {
    revision: number;
    /** The read the page started, streamed in with it. */
    streamed?: Promise<PrivacyData>;
}) {
    return (
        <AfterPaint
            cacheKey="admin-privacy"
            load={loadPrivacyAction}
            streamed={streamed}
            revision={revision}
            skeleton={
                <PrivacySections
                    profiles={<CardSkeleton lines={2} />}
                    discovery={<CardSkeleton lines={4} />}
                />
            }
        >
            {(data) => (
                <PrivacySections
                    profiles={
                        <PublicProfilesForm
                            enabled={data.publicProfiles}
                            followerDefault={data.followerDefault}
                        />
                    }
                    discovery={<PeopleDiscoveryForm policy={data.discovery} />}
                />
            )}
        </AfterPaint>
    );
}
