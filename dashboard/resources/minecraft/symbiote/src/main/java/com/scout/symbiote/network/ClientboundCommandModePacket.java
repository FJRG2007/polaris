package com.scout.symbiote.network;

import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;
import net.neoforged.neoforge.network.handling.IPayloadContext;
import net.minecraft.server.level.ServerPlayer;
import com.scout.symbiote.client.SymbioteClientState;
import com.scout.symbiote.command.PlayerCommandDispatcher;
import java.util.function.Supplier;
import net.minecraft.network.FriendlyByteBuf;

public class ClientboundCommandModePacket implements CustomPacketPayload {
   public static final CustomPacketPayload.Type<ClientboundCommandModePacket> TYPE = new CustomPacketPayload.Type<>(ResourceLocation.fromNamespaceAndPath("symbiote", "clientbound_command_mode_packet"));
   public static final StreamCodec<FriendlyByteBuf, ClientboundCommandModePacket> STREAM_CODEC = StreamCodec.of((buf, pkt) -> encode(pkt, buf), ClientboundCommandModePacket::decode);

   @Override
   public CustomPacketPayload.Type<ClientboundCommandModePacket> type() {
      return TYPE;
   }

   private final int modeOrdinal;

   public ClientboundCommandModePacket(int modeOrdinal) {
      this.modeOrdinal = modeOrdinal;
   }

   public static void encode(ClientboundCommandModePacket pkt, FriendlyByteBuf buf) {
      buf.writeVarInt(pkt.modeOrdinal);
   }

   public static ClientboundCommandModePacket decode(FriendlyByteBuf buf) {
      return new ClientboundCommandModePacket(buf.readVarInt());
   }

   public static void handle(ClientboundCommandModePacket pkt, IPayloadContext ctx) {
      ctx.enqueueWork(() -> SymbioteClientState.updateCommandMode(PlayerCommandDispatcher.CommandMode.fromOrdinalSafe(pkt.modeOrdinal)));
   }
}
