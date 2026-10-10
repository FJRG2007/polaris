package polaris.anticheat.platform.neoforge.registry;

import com.github.retrooper.packetevents.protocol.component.StaticComponentMap;
import com.github.retrooper.packetevents.protocol.item.type.ItemType;
import com.github.retrooper.packetevents.protocol.item.type.ItemTypes;
import com.github.retrooper.packetevents.protocol.mapper.AbstractMappedEntity;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import com.github.retrooper.packetevents.protocol.world.states.type.StateType;
import com.github.retrooper.packetevents.util.mappings.TypesBuilderData;
import org.jetbrains.annotations.Nullable;

import java.util.Set;

/** A mod's item as the engine sees it: its own id, and the defaults the game gives it. */
final class ModdedItemType extends AbstractMappedEntity implements ItemType {

    private final int maxAmount;
    private final int maxDurability;
    private final @Nullable StateType placedType;
    private final Set<ItemTypes.ItemAttribute> attributes;
    private final StaticComponentMap components;

    ModdedItemType(TypesBuilderData data, int maxAmount, int maxDurability, @Nullable StateType placedType,
                   Set<ItemTypes.ItemAttribute> attributes, StaticComponentMap components) {
        super(data);
        this.maxAmount = maxAmount;
        this.maxDurability = maxDurability;
        this.placedType = placedType;
        this.attributes = attributes;
        this.components = components;
    }

    @Override
    public int getMaxAmount() {
        return maxAmount;
    }

    @Override
    public int getMaxDurability() {
        return maxDurability;
    }

    @Override
    public @Nullable ItemType getCraftRemainder() {
        return null;
    }

    @Override
    public @Nullable StateType getPlacedType() {
        return placedType;
    }

    @Override
    public Set<ItemTypes.ItemAttribute> getAttributes() {
        return attributes;
    }

    @Override
    public StaticComponentMap getComponents(ClientVersion version) {
        return components;
    }
}
