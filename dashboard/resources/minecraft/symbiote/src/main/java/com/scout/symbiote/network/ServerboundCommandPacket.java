package com.scout.symbiote.network;

import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.neoforge.network.handling.IPayloadContext;
import net.minecraft.server.level.ServerPlayer;
import com.scout.symbiote.command.PlayerCommandDispatcher;
import java.util.function.Supplier;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.server.level.ServerPlayer;

public class ServerboundCommandPacket implements CustomPacketPayload {
   public static final CustomPacketPayload.Type<ServerboundCommandPacket> TYPE = new CustomPacketPayload.Type<>(ResourceLocation.fromNamespaceAndPath("symbiote", "serverbound_command_packet"));
   public static final StreamCodec<FriendlyByteBuf, ServerboundCommandPacket> STREAM_CODEC = StreamCodec.of((buf, pkt) -> encode(pkt, buf), ServerboundCommandPacket::decode);

   @Override
   public CustomPacketPayload.Type<ServerboundCommandPacket> type() {
      return TYPE;
   }

   private final String commandId;

   public ServerboundCommandPacket(String commandId) {
      this.commandId = commandId;
   }

   public static void encode(ServerboundCommandPacket pkt, FriendlyByteBuf buf) {
      buf.writeUtf(pkt.commandId);
   }

   public static ServerboundCommandPacket decode(FriendlyByteBuf buf) {
      return new ServerboundCommandPacket(buf.readUtf());
   }

   public static void handle(ServerboundCommandPacket pkt, IPayloadContext ctx) {
      ctx.enqueueWork(() -> {
         ServerPlayer player = (ServerPlayer)ctx.player();
         if (player != null) {
            PlayerCommandDispatcher.execute(player, pkt.commandId);
         }
      });
   }
}
