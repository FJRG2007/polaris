import { SectionSkeleton } from "../section-skeleton";

export default function Loading() {
    return <SectionSkeleton parts={[{ kind: "block" }, { kind: "rows", count: 3 }]} />;
}
