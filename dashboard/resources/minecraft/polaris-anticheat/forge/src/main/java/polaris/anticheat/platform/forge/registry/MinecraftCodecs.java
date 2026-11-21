package polaris.anticheat.platform.forge.registry;

import com.github.retrooper.packetevents.wrapper.PacketWrapper;
import io.netty.buffer.ByteBuf;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.syncher.EntityDataSerializer;

/** A modded entity data serializer read and written through PacketEvents' buffer. */
final class MinecraftCodecs {

    private MinecraftCodecs() {
    }

    @SuppressWarnings("unchecked")
    static PacketWrapper.Reader<Object> reader(EntityDataSerializer<?> serializer) {
        EntityDataSerializer<Object> s = (EntityDataSerializer<Object>) serializer;
        return wrapper -> s.read(friendly(wrapper));
    }

    @SuppressWarnings("unchecked")
    static PacketWrapper.Writer<Object> writer(EntityDataSerializer<?> serializer) {
        EntityDataSerializer<Object> s = (EntityDataSerializer<Object>) serializer;
        return (wrapper, value) -> s.write(friendly(wrapper), value);
    }

    private static FriendlyByteBuf friendly(PacketWrapper<?> wrapper) {
        return new FriendlyByteBuf((ByteBuf) wrapper.getBuffer());
    }
}
