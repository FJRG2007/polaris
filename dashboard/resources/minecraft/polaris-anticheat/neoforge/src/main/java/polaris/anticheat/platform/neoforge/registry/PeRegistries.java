package polaris.anticheat.platform.neoforge.registry;

import com.github.retrooper.packetevents.protocol.mapper.MappedEntity;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import com.github.retrooper.packetevents.resources.ResourceLocation;
import com.github.retrooper.packetevents.util.mappings.TypesBuilder;
import com.github.retrooper.packetevents.util.mappings.TypesBuilderData;
import com.github.retrooper.packetevents.util.VersionRange;
import com.github.retrooper.packetevents.util.mappings.VersionedRegistry;

import java.lang.reflect.Field;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * Adds entries to PacketEvents' id tables for content its mappings do not have: a
 * mod's items, entity types and so on. PacketEvents keeps those tables per
 * protocol version and offers no public way to extend them, so this writes the
 * one for the server's version directly.
 */
final class PeRegistries {

    private static final Field TYPE_IDS;
    private static final Field TYPE_NAMES;

    static {
        try {
            TYPE_IDS = VersionedRegistry.class.getDeclaredField("typeIds");
            TYPE_NAMES = VersionedRegistry.class.getDeclaredField("typeNames");
            TYPE_IDS.setAccessible(true);
            TYPE_NAMES.setAccessible(true);
        } catch (ReflectiveOperationException failed) {
            throw new ExceptionInInitializerError(failed);
        }
    }

    private PeRegistries() {
    }

    /** Registry data naming {@code name} with {@code id} on {@code version} only. */
    static TypesBuilderData data(VersionedRegistry<?> registry, ClientVersion version, net.minecraft.resources.ResourceLocation name, int id) {
        TypesBuilder builder = registry.getTypesBuilder();
        int[] ids = new int[builder.getVersions().length];
        Arrays.fill(ids, -1);
        ids[builder.getDataIndex(version)] = id;
        return new TypesBuilderData(new ResourceLocation(name.getNamespace(), name.getPath()), ids, builder, VersionRange.ALL_VERSIONS);
    }

    /** Whether PacketEvents already knows {@code id} on {@code version}. */
    static boolean has(VersionedRegistry<?> registry, ClientVersion version, int id) {
        return registry.getById(version, id) != null;
    }

    @SuppressWarnings("unchecked")
    static <T extends MappedEntity> void put(VersionedRegistry<T> registry, ClientVersion version, int id, T entry) {
        int index = registry.getTypesBuilder().getDataIndex(version);
        try {
            Map<Integer, T>[] ids = (Map<Integer, T>[]) TYPE_IDS.get(registry);
            Map<String, T>[] names = (Map<String, T>[]) TYPE_NAMES.get(registry);
            if (ids[index] == null) ids[index] = new HashMap<>();
            if (names[index] == null) names[index] = new HashMap<>();
            ids[index].put(id, entry);
            names[index].putIfAbsent(entry.getName().toString(), entry);
        } catch (IllegalAccessException failed) {
            throw new IllegalStateException(failed);
        }
    }
}
