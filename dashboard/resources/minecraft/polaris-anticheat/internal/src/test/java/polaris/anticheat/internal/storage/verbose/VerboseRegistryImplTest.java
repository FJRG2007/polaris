package polaris.anticheat.internal.storage.verbose;

import polaris.anticheat.api.storage.DataStore;
import polaris.anticheat.api.storage.DataStoreMetrics;
import polaris.anticheat.api.storage.DeletionReport;
import polaris.anticheat.api.storage.category.Category;
import polaris.anticheat.api.storage.check.CheckCatalogPersistence;
import polaris.anticheat.api.storage.check.CheckCatalogRow;
import polaris.anticheat.api.storage.kind.Operation;
import polaris.anticheat.api.storage.kind.ops.EntityOps;
import polaris.anticheat.api.storage.model.VerboseSchemaRecord;
import polaris.anticheat.api.storage.query.DeleteCriteria;
import polaris.anticheat.api.storage.query.Page;
import polaris.anticheat.api.storage.query.Query;
import polaris.anticheat.api.storage.verbose.Verbose;
import polaris.anticheat.api.storage.verbose.VerboseSchema;
import polaris.anticheat.internal.storage.checks.CheckRegistry;
import org.jetbrains.annotations.NotNull;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

class VerboseRegistryImplTest {

    @Test
    void registerTemplatesEmitsOneChangeForBatch() {
        VerboseRegistryImpl registry = new VerboseRegistryImpl(registrationStore(), writableChecks(), 1);
        AtomicInteger changes = new AtomicInteger();
        registry.onChange(changes::incrementAndGet);

        registry.registerTemplates(() -> {
            registry.registerTemplate("polarisac:test-a", "TestA", null, null, Verbose.of("a={uint}"));
            registry.registerTemplate("polarisac:test-b", "TestB", null, null, Verbose.of("b={uint}"));
        });

        assertEquals(1, changes.get());

        registry.registerTemplate("polarisac:test-c", "TestC", null, null, Verbose.of("c={uint}"));

        assertEquals(2, changes.get());

        registry.registerTemplates(() ->
                registry.registerTemplate("polarisac:test-a", "TestA", null, null, Verbose.of("a={uint}")));

        assertEquals(2, changes.get());
    }

    @Test
    void layoutRetriesAfterTransientSchemaLookupFailure() {
        VerboseSchema schema = VerboseSchema.of("offset:f64", "ok:bool");
        VerboseSchemaRecord record = new VerboseSchemaRecord(
                VerboseSchemaRecord.keyOf(2, 42, schema.version()),
                2,
                42,
                schema.version(),
                schema.layoutBytes(),
                1L);
        FlakyStore store = new FlakyStore(record);
        VerboseRegistryImpl registry = new VerboseRegistryImpl(store, emptyChecks(), 1);

        assertNull(registry.layout(2, 42, schema.version()));
        VerboseSchema.Layout layout = registry.layout(2, 42, schema.version());

        assertNotNull(layout);
        assertEquals(schema.fields(), layout.fields());
        assertEquals(2, store.executeCalls());
    }

    @Test
    void repeatedCheckIdVersionsOnlyInternsNewSchemas() {
        RegistrationStore store = new RegistrationStore();
        CheckRegistry checks = writableChecks();
        VerboseRegistryImpl registry = new VerboseRegistryImpl(store, checks, 1);
        Verbose first = Verbose.of("first={uint}");

        registry.registerTemplate("polarisac:first", "First", null, null, first);
        int firstId = checks.getId("polarisac:first").orElseThrow();

        assertEquals(Map.of(firstId, first.version()), registry.checkIdVersions(checks));
        assertEquals(Map.of(firstId, first.version()), registry.checkIdVersions(checks));
        assertEquals(1, store.getByIdCalls());
        assertEquals(1, store.upsertCalls());

        Verbose second = Verbose.of("second={bool}");
        registry.registerTemplate("polarisac:second", "Second", null, null, second);
        int secondId = checks.getId("polarisac:second").orElseThrow();

        assertEquals(
                Map.of(firstId, first.version(), secondId, second.version()),
                registry.checkIdVersions(checks));
        assertEquals(2, store.getByIdCalls());
        assertEquals(2, store.upsertCalls());
    }

    @Test
    void checkIdVersionsRetriesUntilInterningCompletes() {
        RegistrationStore store = new RegistrationStore(1, 1);
        CheckRegistry checks = writableChecks();
        VerboseRegistryImpl registry = new VerboseRegistryImpl(store, checks, 1);
        Verbose verbose = Verbose.of("value={uint}");

        registry.registerTemplate("polarisac:retry", "Retry", null, null, verbose);
        int checkId = checks.getId("polarisac:retry").orElseThrow();

        assertEquals(1, store.getByIdCalls());
        assertEquals(0, store.upsertCalls());
        assertEquals(Map.of(checkId, verbose.version()), registry.checkIdVersions(checks));
        assertEquals(2, store.getByIdCalls());
        assertEquals(1, store.upsertCalls());

        assertEquals(Map.of(checkId, verbose.version()), registry.checkIdVersions(checks));
        assertEquals(3, store.getByIdCalls());
        assertEquals(2, store.upsertCalls());

        assertEquals(Map.of(checkId, verbose.version()), registry.checkIdVersions(checks));
        assertEquals(3, store.getByIdCalls());
        assertEquals(2, store.upsertCalls());
    }

    @Test
    void registerAfterTemplatePreservesTemplateLayoutResolution() {
        String stableKey = "polarisac:mixed-registration";
        RegistrationStore store = new RegistrationStore();
        CheckRegistry checks = writableChecks();
        VerboseRegistryImpl registry = new VerboseRegistryImpl(store, checks, 1);
        Verbose verbose = Verbose.of("value={uint}");

        registry.registerTemplate(stableKey, "MixedRegistration", null, null, verbose);
        int checkId = checks.getId(stableKey).orElseThrow();
        assertArrayEquals(verbose.layoutBytes(), store.record().layout());

        registry.register(stableKey, verbose.schema());
        int lookupsAfterRegistration = store.getByIdCalls();

        assertEquals(1, store.upsertCalls());
        assertArrayEquals(verbose.layoutBytes(), store.record().layout());
        assertEquals(Map.of(checkId, verbose.version()), registry.checkIdVersions(checks));
        assertEquals(Map.of(checkId, verbose.version()), registry.checkIdVersions(checks));
        assertEquals(lookupsAfterRegistration, store.getByIdCalls());
        assertEquals(1, store.upsertCalls());
    }

    @Test
    void registerAfterTemplateDoesNotHideDifferentSameVersionSchema() {
        String stableKey = "polarisac:mixed-registration-conflict";
        RegistrationStore store = new RegistrationStore();
        CheckRegistry checks = writableChecks();
        VerboseRegistryImpl registry = new VerboseRegistryImpl(store, checks, 1);
        Verbose verbose = Verbose.of("value={uint}");
        VerboseSchema replacement = VerboseSchema.of(verbose.version(), "changed:bool");

        registry.registerTemplate(stableKey, "MixedRegistrationConflict", null, null, verbose);
        int checkId = checks.getId(stableKey).orElseThrow();

        registry.register(stableKey, replacement);

        assertEquals(2, store.getByIdCalls());
        assertEquals(1, store.upsertCalls());
        assertArrayEquals(verbose.layoutBytes(), store.record().layout());
        assertEquals(Map.of(checkId, replacement.version()), registry.checkIdVersions(checks));
        assertEquals(3, store.getByIdCalls());
    }

    private static @NotNull CheckRegistry emptyChecks() {
        return new CheckRegistry(new CheckCatalogPersistence() {
            @Override public Iterable<CheckCatalogRow> loadAll() { return List.of(); }
            @Override public int insert(
                    String stableKey,
                    String display,
                    String description,
                    String introducedVersion,
                    long introducedAt) {
                throw new UnsupportedOperationException();
            }
            @Override public void upsert(CheckCatalogRow row) { throw new UnsupportedOperationException(); }
            @Override public void updateDisplayAndDescription(int checkId, String display, String description) {
                throw new UnsupportedOperationException();
            }
        });
    }

    private static @NotNull CheckRegistry writableChecks() {
        return new CheckRegistry(new InMemoryCheckCatalogPersistence());
    }

    private static @NotNull DataStore registrationStore() {
        return new RegistrationStore();
    }

    private static final class InMemoryCheckCatalogPersistence implements CheckCatalogPersistence {
        private final List<CheckCatalogRow> rows = new ArrayList<>();
        private int nextId = 1;

        @Override
        public synchronized Iterable<CheckCatalogRow> loadAll() {
            return List.copyOf(rows);
        }

        @Override
        public synchronized int insert(
                String stableKey,
                String display,
                String description,
                String introducedVersion,
                long introducedAt) {
            for (CheckCatalogRow row : rows) {
                if (row.stableKey().equals(stableKey)) return row.checkId();
            }
            CheckCatalogRow row = new CheckCatalogRow(
                    nextId++, stableKey, display, description, introducedVersion, introducedAt);
            rows.add(row);
            return row.checkId();
        }

        @Override
        public synchronized void upsert(CheckCatalogRow row) {
            rows.removeIf(existing -> existing.checkId() == row.checkId()
                    || existing.stableKey().equals(row.stableKey()));
            rows.add(row);
        }

        @Override
        public synchronized void updateDisplayAndDescription(int checkId, String display, String description) {
            for (int i = 0; i < rows.size(); i++) {
                CheckCatalogRow row = rows.get(i);
                if (row.checkId() == checkId) {
                    rows.set(i, new CheckCatalogRow(
                            row.checkId(), row.stableKey(), display, description,
                            row.introducedVersion(), row.introducedAt()));
                    return;
                }
            }
            throw new IllegalArgumentException("unknown check id " + checkId);
        }
    }

    private abstract static class StubDataStore implements DataStore {
        @Override
        public <E> void submit(@NotNull Category<E> cat, @NotNull Consumer<E> configurer) {
            throw new UnsupportedOperationException();
        }

        @Override
        @SuppressWarnings("removal")
        public @NotNull <R> CompletionStage<Page<R>> query(@NotNull Category<?> cat, @NotNull Query<R> query) {
            throw new UnsupportedOperationException();
        }

        @Override
        public @NotNull <E> CompletionStage<Void> delete(@NotNull Category<E> cat, @NotNull DeleteCriteria criteria) {
            throw new UnsupportedOperationException();
        }

        @Override
        public @NotNull CompletionStage<DeletionReport> forgetPlayer(@NotNull UUID uuid) {
            throw new UnsupportedOperationException();
        }

        @Override
        public @NotNull CompletionStage<Long> countViolationsInSession(@NotNull UUID sessionId) {
            throw new UnsupportedOperationException();
        }

        @Override
        public @NotNull CompletionStage<Long> countUniqueChecksInSession(@NotNull UUID sessionId) {
            throw new UnsupportedOperationException();
        }

        @Override
        public @NotNull CompletionStage<Long> countSessionsByPlayer(@NotNull UUID player) {
            throw new UnsupportedOperationException();
        }

        @Override
        public @NotNull DataStoreMetrics metrics() {
            throw new UnsupportedOperationException();
        }

        @Override
        public void flushAndClose(long drainTimeoutMs) {
        }
    }

    private static final class RegistrationStore extends StubDataStore {
        private final int getFailures;
        private final int upsertFailures;
        private final AtomicInteger getByIdCalls = new AtomicInteger();
        private final AtomicInteger upsertCalls = new AtomicInteger();
        private final ConcurrentMap<String, VerboseSchemaRecord> records = new ConcurrentHashMap<>();
        private final AtomicReference<VerboseSchemaRecord> record = new AtomicReference<>();

        private RegistrationStore() {
            this(0, 0);
        }

        private RegistrationStore(int getFailures, int upsertFailures) {
            this.getFailures = getFailures;
            this.upsertFailures = upsertFailures;
        }

        private int getByIdCalls() {
            return getByIdCalls.get();
        }

        private int upsertCalls() {
            return upsertCalls.get();
        }

        private @NotNull VerboseSchemaRecord record() {
            return record.get();
        }

        @Override
        @SuppressWarnings("unchecked")
        public @NotNull <R> CompletionStage<R> execute(@NotNull Operation<R> op) {
            if (op instanceof EntityOps.GetByIdOp<?, ?> getById) {
                if (getByIdCalls.incrementAndGet() <= getFailures) {
                    throw new RuntimeException("transient");
                }
                return (CompletionStage<R>) CompletableFuture.completedFuture(
                        Optional.ofNullable(records.get((String) getById.id())));
            }
            if (op instanceof EntityOps.UpsertOp<?> upsert) {
                if (upsertCalls.incrementAndGet() <= upsertFailures) {
                    throw new RuntimeException("transient");
                }
                VerboseSchemaRecord persisted = (VerboseSchemaRecord) upsert.record();
                records.put(persisted.schemaKey(), persisted);
                record.set(persisted);
                return (CompletionStage<R>) CompletableFuture.completedFuture(null);
            }
            throw new UnsupportedOperationException(op.getClass().getName());
        }
    }

    private static final class FlakyStore extends StubDataStore {
        private final VerboseSchemaRecord record;
        private final AtomicInteger executeCalls = new AtomicInteger();

        private FlakyStore(@NotNull VerboseSchemaRecord record) {
            this.record = record;
        }

        private int executeCalls() {
            return executeCalls.get();
        }

        @Override
        @SuppressWarnings("unchecked")
        public @NotNull <R> CompletionStage<R> execute(@NotNull Operation<R> op) {
            if (executeCalls.incrementAndGet() == 1) {
                throw new RuntimeException("transient");
            }
            return (CompletionStage<R>) CompletableFuture.completedFuture(Optional.of(record));
        }
    }
}
