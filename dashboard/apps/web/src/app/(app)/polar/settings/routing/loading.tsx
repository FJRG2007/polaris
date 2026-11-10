import { SectionSkeleton } from "../section-skeleton";

export default function Loading() {
    return <SectionSkeleton parts={[{ kind: "banner" }, { kind: "rows", count: 3 }, { kind: "rows", count: 1 }]} />;
}
