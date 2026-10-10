/*
 * This file is part of packetevents - https://github.com/retrooper/packetevents
 * Copyright (C) 2024 retrooper and contributors
 *
 * Carried over from packetevents' Fabric platform (v2.14.0) to NeoForge by Polaris.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
package polaris.anticheat.platform.neoforge.packetevents;

import com.github.retrooper.packetevents.PacketEvents;
import com.github.retrooper.packetevents.PacketEventsAPI;
import com.github.retrooper.packetevents.event.UserConnectEvent;
import com.github.retrooper.packetevents.event.UserLoginEvent;
import com.github.retrooper.packetevents.protocol.ConnectionState;
import com.github.retrooper.packetevents.protocol.PacketSide;
import com.github.retrooper.packetevents.protocol.player.ClientVersion;
import com.github.retrooper.packetevents.protocol.player.User;
import com.github.retrooper.packetevents.protocol.player.UserProfile;
import com.github.retrooper.packetevents.util.PacketEventsImplHelper;
import io.netty.channel.Channel;
import io.netty.channel.ChannelFutureListener;
import io.netty.channel.ChannelPipeline;
import net.minecraft.SharedConstants;
import net.minecraft.network.protocol.PacketFlow;
import net.minecraft.server.level.ServerPlayer;

/**
 * The hooks the Fabric platform runs from its mixins, called here from the
 * connection mixin and from NeoForge's player events.
 */
public final class NeoForgePacketEvents {

    /** Whether any connection had the handlers put on, so the mixin landed. */
    private static volatile boolean injectedOnce;

    private NeoForgePacketEvents() {
    }

    public static boolean injectedOnce() {
        return injectedOnce;
    }

    /** {@code Connection.configureSerialization}, at its end. */
    public static void onConfigureSerialization(ChannelPipeline pipeline, PacketFlow flow, boolean memoryOnly) {
        PacketEventsAPI<?> api = PacketEvents.getAPI();
        // A server's connections receive what flows to it; a memory channel is the
        // integrated server's own client.
        if (api == null || memoryOnly || flow != PacketFlow.SERVERBOUND) return;
        if (pipeline.get("splitter") == null || pipeline.get("prepender") == null) return;

        Channel channel = pipeline.channel();
        User user = new User(channel, ConnectionState.HANDSHAKING,
                ClientVersion.getById(SharedConstants.getProtocolVersion()), new UserProfile(null, null));
        api.getProtocolManager().setUser(channel, user);

        UserConnectEvent connectEvent = new UserConnectEvent(user);
        api.getEventManager().callEvent(connectEvent);
        if (connectEvent.isCancelled()) {
            channel.unsafe().closeForcibly();
            return;
        }

        PacketSide side = api.getInjector().getPacketSide();
        pipeline.addAfter("splitter", PacketEvents.DECODER_NAME, new PacketDecoder(side, user));
        pipeline.addAfter("prepender", PacketEvents.ENCODER_NAME, new PacketEncoder(side, user));
        channel.closeFuture().addListener((ChannelFutureListener) future ->
                PacketEventsImplHelper.handleDisconnection(user.getChannel(), user.getUUID()));
        injectedOnce = true;
    }

    /** A player object now stands for this connection: at login, and after a respawn. */
    public static void onPlayerPlaced(ServerPlayer player) {
        PacketEventsAPI<?> api = PacketEvents.getAPI();
        if (api == null) return;
        api.getInjector().setPlayer(player.connection.getConnection().channel(), player);
    }

    /**
     * A player is in: the login event the engine starts tracking them on. Returns
     * false when their connection never had the handlers put on, so the engine
     * cannot see them.
     */
    public static boolean onPlayerLogin(ServerPlayer player) {
        PacketEventsAPI<?> api = PacketEvents.getAPI();
        if (api == null) return false;
        onPlayerPlaced(player);
        User user = api.getPlayerManager().getUser(player);
        if (user == null) return false;
        api.getEventManager().callEvent(new UserLoginEvent(user, player));
        return true;
    }
}
