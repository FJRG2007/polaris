/**
 * Places, as core sees it: the one object that answers every question the
 * dashboard asks of this app.
 *
 * Core never imports Places' modules; it asks the app extension registry, and
 * this is what is registered there.
 */

import type { AppHostTypes } from "@polaris/app-host";

type AppExtension = AppHostTypes["AppExtension"];

// Places' modules are loaded when a hook runs. This module is loaded with core's
// registry, and what Places is built on reaches the session, the cameras and the
// container runtime.
const sweeps = () => import("./sweeps");

const MINUTE = 60 * 1000;

export const placesExtension: AppExtension = {
    id: "home",

    jobs: () => [
        {
            key: "home-recording",
            // A minute, and each pass only tops up: a camera already writing a
            // segment is left alone, and one that has just finished starts the next.
            everyMs: Number(process.env.POLARIS_HOME_RECORDING_MS) || MINUTE,
            // Leased, because two runners would each start a segment on the same
            // camera and write the same footage to the disk twice.
            leaseMs: 20 * MINUTE,
            run: async () => (await sweeps()).sweepContinuousRecording()
        },
        {
            key: "home-availability",
            // A minute. A camera that has gone quiet is only useful to know about
            // quickly, and the pass is one cached frame per camera - which is what
            // the wall already asks for whenever somebody has it open.
            everyMs: Number(process.env.POLARIS_HOME_AVAILABILITY_MS) || MINUTE,
            // Leased: two runners asking the same camera at the same moment would
            // each decide it was the one to write the outage down, and the house
            // would be told twice.
            leaseMs: 5 * MINUTE,
            run: async () => (await import("./reachability")).sweepCameraReachability()
        },
        {
            key: "home-retention",
            // Footage is the only part of the house that grows whether or not anybody
            // uses it, so this is the job that decides whether a disk fills.
            everyMs: Number(process.env.POLARIS_HOME_RETENTION_MS) || 15 * MINUTE,
            // Leased: it removes files, and two runners racing on the same clip means
            // one of them fails on a file the other already dropped. Longer than the
            // cadence, so a pass that runs over does not have the next one start
            // beside it.
            leaseMs: 30 * MINUTE,
            run: async () => (await sweeps()).sweepHomeRetention()
        }
    ],

    onBoot: () => {
        // Bring Places' own containers - the camera relay, the vision worker, the
        // recognizer - to the version of Polaris that is running. They are built
        // and published by the same CI run as the dashboard and nothing else
        // upgrades them. Once per build, and only what is meant to be running.
        void import("./side-upgrade")
            .then(({ upgradeHomeServices }) => upgradeHomeServices())
            .catch((error) =>
                console.error("polaris: could not bring Home's own containers up to date:", error)
            );
        // Listen to the cameras that decide for themselves that something moved:
        // one long-poll per camera and no CPU. Does nothing without cameras.
        void import("./watcher")
            .then(({ startCameraWatcher }) => startCameraWatcher())
            .catch((error) => console.error("polaris: could not start the camera watcher:", error));
    },

    // Places is the one app a single item of can be lent to somebody who holds
    // none of its permissions - one door, one camera - and somebody holding a key
    // to a door has an app to open.
    reaches: async (userId) => (await import("./sharing")).reachesPlaces(userId)
};
