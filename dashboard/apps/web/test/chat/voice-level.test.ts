// @vitest-environment jsdom
/**
 * A level meter starts its own audio graph after the permission prompt, out of
 * the click that asked for it, so the browser may hand it over suspended - and a
 * suspended graph reads as silence. It has to ask for it to run.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { measureVoice } from "@/app/(app)/chat/voice-level";

afterEach(() => vi.unstubAllGlobals());

describe("measureVoice", () => {
    it("resumes the graph it opens", () => {
        const resume = vi.fn(async () => undefined);
        vi.stubGlobal("MediaStream", class {});
        vi.stubGlobal(
            "AudioContext",
            class {
                state = "suspended";
                resume = resume;
                close = async () => undefined;
                createMediaStreamSource() {
                    return { connect: () => undefined, disconnect: () => undefined };
                }
                createAnalyser() {
                    return {
                        fftSize: 0,
                        smoothingTimeConstant: 0,
                        getFloatTimeDomainData: () => undefined
                    };
                }
            }
        );
        const meter = measureVoice({} as MediaStreamTrack);
        expect(meter).not.toBeNull();
        expect(resume).toHaveBeenCalledTimes(1);
        meter?.stop();
    });
});
