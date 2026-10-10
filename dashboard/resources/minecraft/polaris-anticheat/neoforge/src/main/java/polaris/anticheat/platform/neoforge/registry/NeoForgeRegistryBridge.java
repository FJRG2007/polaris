package polaris.anticheat.platform.neoforge.registry;

import com.github.retrooper.packetevents.PacketEvents;
import com.github.retrooper.packetevents.protocol.attribute.Attributes;
import com.github.retrooper.packetevents.protocol.attribute.StaticAttribute;
import com.github.retrooper.packetevents.protocol.component.ComponentType;
import com.github.retrooper.packetevents.protocol.component.ComponentTypes;
import com.github.retrooper.packetevents.protocol.component.StaticComponentMap;
import com.github.retrooper.packetevents.protocol.component.StaticComponentType;
import com.github.retrooper.packetevents.protocol.entity.data.EntityDataType;
import com.github.retrooper.packetevents.protocol.entity.data.EntityDataTypes;
import com.github.retrooper.packetevents.protocol.entity.type.EntityTypes;
import com.github.retrooper.packetevents.protocol.entity.type.StaticEntityType;
import com.github.retrooper.packetevents.protocol.item.type.ItemType;
import com.github.retrooper.packetevents.protocol.item.type.ItemTypes;
import com.github.retrooper.packetevents.protocol.mapper.MappedEntity;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import com.github.retrooper.packetevents.protocol.potion.PotionTypes;
import com.github.retrooper.packetevents.protocol.potion.StaticPotionType;
import com.github.retrooper.packetevents.protocol.world.states.WrappedBlockState;
import com.github.retrooper.packetevents.util.mappings.VersionedRegistry;
import com.github.retrooper.packetevents.wrapper.PacketWrapper;
import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import net.minecraft.core.Registry;
import net.minecraft.core.RegistryAccess;
import net.minecraft.core.component.DataComponentType;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.component.TypedDataComponent;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.syncher.EntityDataSerializer;
import net.minecraft.network.syncher.EntityDataSerializers;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.entity.ai.attributes.RangedAttribute;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.neoforged.neoforge.network.connection.ConnectionType;
import net.neoforged.neoforge.registries.NeoForgeRegistries;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import polaris.anticheat.utils.anticheat.ModdedContent;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Teaches PacketEvents the content this server's mods add, so the engine can read
 * every packet a modded client is sent and simulate players next to modded blocks.
 *
 * Runs once when the server starts, after every registry is frozen and before
 * anybody can join. It first checks that each vanilla entry has the id PacketEvents
 * expects: if one does not, the engine's view of the world would be wrong and it
 * must not run, so this throws and the caller keeps it off.
 */
public final class NeoForgeRegistryBridge {

    private static final Logger LOG = LoggerFactory.getLogger("PolarisAC");

    private final ClientVersion version;
    private final RegistryAccess registries;
    private final List<String> mismatches = new ArrayList<>();
    private int defaultsDropped;

    private NeoForgeRegistryBridge(ClientVersion version, RegistryAccess registries) {
        this.version = version;
        this.registries = registries;
    }

    public static void install(MinecraftServer server) throws Exception {
        ClientVersion version = PacketEvents.getAPI().getServerManager().getVersion().toClientVersion();
        new NeoForgeRegistryBridge(version, server.registryAccess()).run();
    }

    private void run() throws Exception {
        int components = bridge(BuiltInRegistries.DATA_COMPONENT_TYPE, ComponentTypes.getRegistry(),
                (data, type) -> type.isTransient() ? null : new StaticComponentType<>(data,
                        MinecraftCodecs.reader(type.streamCodec(), registries), MinecraftCodecs.writer(type.streamCodec(), registries)));
        int entityData = bridgeEntityData();
        int entities = bridge(BuiltInRegistries.ENTITY_TYPE, EntityTypes.getRegistry(),
                // Not living to the engine: no reach or hitbox check against a size it does not know
                (data, type) -> new StaticEntityType(data, EntityTypes.ENTITY));
        int attributes = bridge(BuiltInRegistries.ATTRIBUTE, Attributes.getRegistry(),
                (data, attribute) -> attribute instanceof RangedAttribute ranged
                        ? new StaticAttribute(data, null, ranged.getDefaultValue(), ranged.getMinValue(), ranged.getMaxValue())
                        : new StaticAttribute(data, null, attribute.getDefaultValue(), -Double.MAX_VALUE, Double.MAX_VALUE));
        int effects = bridge(BuiltInRegistries.MOB_EFFECT, PotionTypes.getRegistry(),
                (data, effect) -> new StaticPotionType(data));

        BlockStandIns blocks = BlockStandIns.install(version);
        if (blocks.vanillaMismatches > 0) {
            mismatches.add(blocks.vanillaMismatches + " block states, e.g. " + blocks.mismatchSamples);
        }
        if (!mismatches.isEmpty()) {
            throw new IllegalStateException("this server's ids differ from the ones the anti-cheat knows: " + mismatches);
        }

        Set<ItemType> moddedItems = new HashSet<>();
        int items = bridgeItems(blocks, moddedItems);
        ModdedContent.install(blocks.modded, blocks.unmodelled, moddedItems);

        if (blocks.modded.isEmpty() && items + components + entityData + entities + attributes + effects == 0) {
            LOG.info("Polaris anti-cheat: no modded content on this server");
            return;
        }
        Map<String, String> perMod = new TreeMap<>();
        blocks.perMod.forEach((mod, c) -> perMod.put(mod, c[0] + " simulated as vanilla, " + c[1] + " unmodelled"));
        LOG.info("Polaris anti-cheat: modded block states: {} simulated as their vanilla equal, {} unmodelled "
                        + "(players next to them are not predicted); by mod {}",
                blocks.matched, blocks.unmodelled.cardinality(), perMod);
        Map<String, Integer> why = new TreeMap<>();
        blocks.reasons.forEach((reason, n) -> why.put(reason + " (e.g. " + blocks.samples.get(reason) + ")", n[0]));
        LOG.info("Polaris anti-cheat: unmodelled because {}", why);
        LOG.info("Polaris anti-cheat: modded items {}, item components {}, entity types {}, entity data {}, "
                + "attributes {}, effects {}; {} item defaults could not be read", items, components, entities,
                entityData, attributes, effects, defaultsDropped);
    }

    /**
     * Checks the vanilla entries of {@code source} against PacketEvents and adds a
     * stand-in for every other one. Returns how many were added.
     */
    private <S, T extends MappedEntity> int bridge(Registry<S> source, VersionedRegistry<T> target,
                                                   StandInFactory<S, T> factory) {
        int added = 0;
        int wrong = 0;
        String sample = null;
        for (S entry : source) {
            int id = source.getId(entry);
            ResourceLocation key = source.getKey(entry);
            if (key == null) continue;
            T known = target.getById(version, id);
            if (key.getNamespace().equals(ResourceLocation.DEFAULT_NAMESPACE)) {
                if (known == null || !known.getName().toString().equals(key.toString())) {
                    wrong++;
                    if (sample == null) sample = key + "#" + id + "->" + (known == null ? "none" : known.getName());
                }
                continue;
            }
            if (known != null) continue;
            T standIn = factory.create(PeRegistries.data(target, version, key, id), entry);
            if (standIn == null) continue;
            PeRegistries.put(target, version, id, standIn);
            added++;
        }
        if (wrong > 0) mismatches.add(wrong + " " + target.getRegistryKey() + ", e.g. " + sample);
        return added;
    }

    private int bridgeEntityData() {
        VersionedRegistry<EntityDataType<?>> target = EntityDataTypes.getRegistry();
        int added = 0;
        for (EntityDataSerializer<?> serializer : NeoForgeRegistries.ENTITY_DATA_SERIALIZERS) {
            ResourceLocation key = NeoForgeRegistries.ENTITY_DATA_SERIALIZERS.getKey(serializer);
            int id = EntityDataSerializers.getSerializedId(serializer);
            if (key == null || id < 0 || target.getById(version, id) != null) continue;
            EntityDataType<Object> type = new EntityDataType<>(PeRegistries.data(target, version, key, id),
                    MinecraftCodecs.reader(serializer.codec(), registries), MinecraftCodecs.writer(serializer.codec(), registries));
            PeRegistries.put(target, version, id, type);
            added++;
        }
        return added;
    }

    private int bridgeItems(BlockStandIns blocks, Set<ItemType> moddedItems) {
        VersionedRegistry<ItemType> target = ItemTypes.getRegistry();
        int added = 0;
        int wrong = 0;
        String sample = null;
        for (Item item : BuiltInRegistries.ITEM) {
            int id = BuiltInRegistries.ITEM.getId(item);
            ResourceLocation key = BuiltInRegistries.ITEM.getKey(item);
            ItemType known = target.getById(version, id);
            if (key.getNamespace().equals(ResourceLocation.DEFAULT_NAMESPACE)) {
                if (known == null || !known.getName().toString().equals(key.toString())) {
                    wrong++;
                    if (sample == null) sample = key + "#" + id;
                }
                continue;
            }
            if (known != null) continue;
            ItemStack stack = new ItemStack(item);
            WrappedBlockState placed = item instanceof BlockItem blockItem ? blocks.defaults.get(blockItem.getBlock()) : null;
            ItemType type = new ModdedItemType(PeRegistries.data(target, version, key, id),
                    item.getDefaultMaxStackSize(), stack.getOrDefault(DataComponents.MAX_DAMAGE, 0),
                    placed == null ? null : placed.getType(), attributesOf(stack), defaultsOf(item));
            PeRegistries.put(target, version, id, type);
            moddedItems.add(type);
            added++;
        }
        if (wrong > 0) throw new IllegalStateException("this server's item ids differ from the ones the anti-cheat knows: "
                + wrong + ", e.g. " + sample);
        return added;
    }

    private static Set<ItemTypes.ItemAttribute> attributesOf(ItemStack stack) {
        Set<ItemTypes.ItemAttribute> attributes = EnumSet.noneOf(ItemTypes.ItemAttribute.class);
        if (stack.has(DataComponents.FOOD)) attributes.add(ItemTypes.ItemAttribute.EDIBLE);
        if (stack.is(ItemTags.SWORDS)) attributes.add(ItemTypes.ItemAttribute.SWORD);
        if (stack.is(ItemTags.PICKAXES)) attributes.add(ItemTypes.ItemAttribute.PICKAXE);
        if (stack.is(ItemTags.AXES)) attributes.add(ItemTypes.ItemAttribute.AXE);
        if (stack.is(ItemTags.SHOVELS)) attributes.add(ItemTypes.ItemAttribute.SHOVEL);
        if (stack.is(ItemTags.HOES)) attributes.add(ItemTypes.ItemAttribute.HOE);
        return attributes;
    }

    /** The item's default components in PacketEvents' terms, through the network form both sides share. */
    @SuppressWarnings({"unchecked", "rawtypes"})
    private StaticComponentMap defaultsOf(Item item) {
        StaticComponentMap.Builder builder = StaticComponentMap.builder();
        for (TypedDataComponent<?> component : item.components()) {
            DataComponentType<?> type = component.type();
            if (type.isTransient()) continue;
            ComponentType<?> known = ComponentTypes.getById(version, BuiltInRegistries.DATA_COMPONENT_TYPE.getId(type));
            if (known == null) continue;
            ByteBuf buffer = Unpooled.buffer();
            try {
                ((StreamCodec) type.streamCodec()).encode(new RegistryFriendlyByteBuf(buffer, registries, ConnectionType.NEOFORGE), component.value());
                Object value = known.read(PacketWrapper.createUniversalPacketWrapper(buffer));
                if (value != null) builder.set((ComponentType<Object>) known, value);
            } catch (Throwable failed) {
                defaultsDropped++;
            } finally {
                buffer.release();
            }
        }
        return builder.build();
    }

    @FunctionalInterface
    private interface StandInFactory<S, T> {
        T create(com.github.retrooper.packetevents.util.mappings.TypesBuilderData data, S source);
    }
}
