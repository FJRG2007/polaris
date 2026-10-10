package polaris.anticheat.platform.neoforge.utils;

import com.github.retrooper.packetevents.netty.buffer.ByteBufHelper;
import com.github.retrooper.packetevents.protocol.item.ItemStack;
import com.github.retrooper.packetevents.protocol.player.GameMode;
import com.github.retrooper.packetevents.protocol.player.InteractionHand;
import com.github.retrooper.packetevents.protocol.world.BlockFace;
import com.github.retrooper.packetevents.wrapper.PacketWrapper;
import io.github.retrooper.packetevents.adventure.serializer.gson.GsonComponentSerializer;
import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import net.kyori.adventure.text.Component;
import net.minecraft.core.Direction;
import net.minecraft.core.RegistryAccess;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.GameType;
import org.jetbrains.annotations.Nullable;
import polaris.anticheat.platform.neoforge.NeoForgeServer;
import polaris.anticheat.utils.anticheat.LogUtil;

/** Between Minecraft's types and PacketEvents', as the upstream Fabric platform does it for 1.21.4. */
public final class NeoForgeConversion {

    private static volatile boolean warnedItem;

    private NeoForgeConversion() {
    }

    /**
     * A server item as PacketEvents reads it off the wire: encoded with Minecraft's
     * own codec, read back by PacketEvents. An item it cannot read comes back empty
     * instead of throwing on the tick that asked.
     */
    public static ItemStack fromNativeItemStack(net.minecraft.world.item.ItemStack stack) {
        if (stack == null || stack.isEmpty()) return ItemStack.EMPTY;
        MinecraftServer server = NeoForgeServer.get();
        RegistryAccess registries = server != null ? server.registryAccess() : RegistryAccess.EMPTY;
        ByteBuf buffer = Unpooled.buffer();
        try {
            RegistryFriendlyByteBuf wire = new RegistryFriendlyByteBuf(buffer, registries);
            net.minecraft.world.item.ItemStack.STREAM_CODEC.encode(wire, stack);
            PacketWrapper<?> wrapper = PacketWrapper.createUniversalPacketWrapper(buffer);
            return wrapper.readItemStack();
        } catch (Exception failed) {
            if (!warnedItem) {
                warnedItem = true;
                LogUtil.warn("Could not read an item for the anti-cheat (" + stack + "): " + failed);
            }
            return ItemStack.EMPTY;
        } finally {
            ByteBufHelper.release(buffer);
        }
    }

    public static net.minecraft.network.chat.Component toNativeText(Component component) {
        return net.minecraft.network.chat.Component.Serializer.fromJson(
                GsonComponentSerializer.gson().serializeToTree(component), RegistryAccess.EMPTY);
    }

    public static GameType toNativeGameMode(GameMode gameMode) {
        return switch (gameMode) {
            case CREATIVE -> GameType.CREATIVE;
            case SURVIVAL -> GameType.SURVIVAL;
            case ADVENTURE -> GameType.ADVENTURE;
            case SPECTATOR -> GameType.SPECTATOR;
        };
    }

    public static GameMode fromNativeGameMode(GameType gameType) {
        return switch (gameType) {
            case CREATIVE -> GameMode.CREATIVE;
            case SURVIVAL -> GameMode.SURVIVAL;
            case ADVENTURE -> GameMode.ADVENTURE;
            case SPECTATOR -> GameMode.SPECTATOR;
        };
    }

    public static @Nullable InteractionHand fromNativeHand(@Nullable net.minecraft.world.InteractionHand hand) {
        return hand == null ? null : switch (hand) {
            case OFF_HAND -> InteractionHand.OFF_HAND;
            case MAIN_HAND -> InteractionHand.MAIN_HAND;
        };
    }

    public static BlockFace fromDirection(Direction direction) {
        return switch (direction) {
            case NORTH -> BlockFace.NORTH;
            case SOUTH -> BlockFace.SOUTH;
            case WEST -> BlockFace.WEST;
            case EAST -> BlockFace.EAST;
            case UP -> BlockFace.UP;
            case DOWN -> BlockFace.DOWN;
        };
    }
}
