/** What can be wrong with a shared screen, as the report dialog offers it. */
export const STREAM_PROBLEMS = ["black", "choppy", "blurry", "sound", "other"] as const;

export type StreamProblem = (typeof STREAM_PROBLEMS)[number];
