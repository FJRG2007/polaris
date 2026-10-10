package polaris.anticheat.platform.neoforge.registry;

import com.github.retrooper.packetevents.wrapper.PacketWrapper;
import io.netty.buffer.ByteBuf;
import net.minecraft.core.RegistryAccess;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.neoforged.neoforge.network.connection.ConnectionType;

/**
 * Reads and writes a mod's own value with Minecraft's codec for it, on the buffer
 * PacketEvents is reading. A mod's item component or entity-data value is not
 * length-prefixed, so the only way to step over it exactly is to decode it as the
 * game does. The value is kept as the game's object; the engine never looks inside.
 */
final class MinecraftCodecs {

    private MinecraftCodecs() {
    }

    @SuppressWarnings("unchecked")
    static PacketWrapper.Reader<Object> reader(StreamCodec<? super RegistryFriendlyByteBuf, ?> codec, RegistryAccess registries) {
        StreamCodec<RegistryFriendlyByteBuf, Object> c = (StreamCodec<RegistryFriendlyByteBuf, Object>) codec;
        return wrapper -> c.decode(friendly(wrapper, registries));
    }

    @SuppressWarnings("unchecked")
    static PacketWrapper.Writer<Object> writer(StreamCodec<? super RegistryFriendlyByteBuf, ?> codec, RegistryAccess registries) {
        StreamCodec<RegistryFriendlyByteBuf, Object> c = (StreamCodec<RegistryFriendlyByteBuf, Object>) codec;
        return (wrapper, value) -> c.encode(friendly(wrapper, registries), value);
    }

    private static RegistryFriendlyByteBuf friendly(PacketWrapper<?> wrapper, RegistryAccess registries) {
        // Players on a modded server run the modded client; that is what the server encodes for.
        return new RegistryFriendlyByteBuf((ByteBuf) wrapper.getBuffer(), registries, ConnectionType.NEOFORGE);
    }
}
