package polaris.anticheat.platform.neoforge.player;

import com.github.retrooper.packetevents.PacketEvents;
import com.github.retrooper.packetevents.protocol.player.GameMode;
import com.github.retrooper.packetevents.protocol.player.User;
import com.github.retrooper.packetevents.util.Vector3d;
import com.github.retrooper.packetevents.wrapper.play.server.WrapperPlayServerPluginMessage;
import net.kyori.adventure.text.Component;
import net.minecraft.network.syncher.EntityDataAccessor;
import net.minecraft.server.level.ServerPlayer;
import org.jetbrains.annotations.Nullable;
import polaris.anticheat.platform.api.entity.PolarisEntity;
import polaris.anticheat.platform.api.player.BlockTranslator;
import polaris.anticheat.platform.api.player.PlatformInventory;
import polaris.anticheat.platform.api.player.PlatformPlayer;
import polaris.anticheat.platform.api.sender.Sender;
import polaris.anticheat.platform.neoforge.NeoForgeLoader;
import polaris.anticheat.platform.neoforge.entity.NeoForgePolarisEntity;
import polaris.anticheat.platform.neoforge.utils.NeoForgeConversion;
import polaris.anticheat.utils.common.arguments.CommonPolarisArguments;

import java.lang.reflect.Field;

public final class NeoForgePlatformPlayer extends NeoForgePolarisEntity<ServerPlayer> implements PlatformPlayer {

    private static final @Nullable EntityDataAccessor<Byte> SHARED_FLAGS = sharedFlags();

    private final NeoForgePlatformInventory inventory = new NeoForgePlatformInventory(this);
    private final @Nullable User user;

    public NeoForgePlatformPlayer(ServerPlayer player) {
        super(player);
        if (CommonPolarisArguments.USE_CHAT_FAST_BYPASS.value()) {
            Object channel = PacketEvents.getAPI().getProtocolManager().getChannel(player.getUUID());
            this.user = channel == null ? null : PacketEvents.getAPI().getProtocolManager().getUser(channel);
        } else {
            this.user = null;
        }
    }

    @SuppressWarnings("unchecked")
    private static @Nullable EntityDataAccessor<Byte> sharedFlags() {
        try {
            Field field = net.minecraft.world.entity.Entity.class.getDeclaredField("DATA_SHARED_FLAGS_ID");
            field.setAccessible(true);
            return (EntityDataAccessor<Byte>) field.get(null);
        } catch (ReflectiveOperationException | RuntimeException missing) {
            return null;
        }
    }

    public ServerPlayer serverPlayer() {
        return entity;
    }

    @Override
    public void kickPlayer(String textReason) {
        entity.connection.disconnect(net.minecraft.network.chat.Component.literal(textReason));
    }

    @Override
    public void resyncSharedFlags() {
        // Sends the player's flags (sneaking, sprinting, gliding) again, as the Fabric
        // platform does by marking them dirty.
        if (SHARED_FLAGS != null) {
            entity.getEntityData().set(SHARED_FLAGS, entity.getEntityData().get(SHARED_FLAGS), true);
        }
    }

    @Override
    public boolean hasPermission(String permission) {
        return getSender().hasPermission(permission);
    }

    @Override
    public boolean hasPermission(String permission, boolean defaultIfUnset) {
        return getSender().hasPermission(permission, defaultIfUnset);
    }

    @Override
    public void sendMessage(String message) {
        if (user != null) {
            user.sendMessage(message);
        } else {
            entity.sendSystemMessage(net.minecraft.network.chat.Component.literal(message));
        }
    }

    @Override
    public void sendMessage(Component message) {
        if (user != null) {
            user.sendMessage(message);
        } else {
            entity.sendSystemMessage(NeoForgeConversion.toNativeText(message));
        }
    }

    @Override
    public void updateInventory() {
        entity.containerMenu.broadcastChanges();
    }

    @Override
    public Vector3d getPosition() {
        return new Vector3d(entity.getX(), entity.getY(), entity.getZ());
    }

    @Override
    public PlatformInventory getInventory() {
        return inventory;
    }

    @Override
    public @Nullable PolarisEntity getVehicle() {
        var vehicle = entity.getVehicle();
        return vehicle == null ? null : new NeoForgePolarisEntity<>(vehicle);
    }

    @Override
    public GameMode getGameMode() {
        return NeoForgeConversion.fromNativeGameMode(entity.gameMode.getGameModeForPlayer());
    }

    @Override
    public void setGameMode(GameMode gameMode) {
        entity.setGameMode(NeoForgeConversion.toNativeGameMode(gameMode));
    }

    @Override
    public boolean isExternalPlayer() {
        return false;
    }

    @Override
    public void sendPluginMessage(String channelName, byte[] byteArray) {
        Object channel = PacketEvents.getAPI().getProtocolManager().getChannel(entity.getUUID());
        User target = channel == null ? null : PacketEvents.getAPI().getProtocolManager().getUser(channel);
        if (target != null) {
            target.sendPacket(new WrapperPlayServerPluginMessage(
                    channelName.equals("BungeeCord") ? "bungeecord:main" : channelName, byteArray));
        }
    }

    @Override
    public Sender getSender() {
        return NeoForgeLoader.get().getSenderFactory().wrap(entity.createCommandSourceStack());
    }

    @Override
    public void replaceNativePlayer(Object nativePlayerObject) {
        setNativeEntity((ServerPlayer) nativePlayerObject);
    }

    @Override
    public BlockTranslator getBlockTranslator() {
        return BlockTranslator.IDENTITY;
    }

    @Override
    public boolean isOnline() {
        return !entity.hasDisconnected();
    }

    @Override
    public String getName() {
        return entity.getGameProfile().getName();
    }
}
