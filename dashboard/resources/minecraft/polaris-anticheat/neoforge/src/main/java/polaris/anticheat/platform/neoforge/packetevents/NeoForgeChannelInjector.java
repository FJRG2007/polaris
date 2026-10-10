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
import com.github.retrooper.packetevents.injector.ChannelInjector;
import com.github.retrooper.packetevents.protocol.PacketSide;
import com.github.retrooper.packetevents.protocol.player.User;
import io.netty.channel.Channel;
import org.jetbrains.annotations.Nullable;

/** Nothing to inject at start: every connection gets its handlers as it opens. */
final class NeoForgeChannelInjector implements ChannelInjector {

    @Override
    public void inject() {
    }

    @Override
    public void uninject() {
    }

    @Override
    public boolean isPlayerSet(@Nullable Object ch) {
        if (!(ch instanceof Channel channel)) return false;
        if (channel.pipeline().get(PacketEvents.ENCODER_NAME) instanceof PacketEncoder encoder && encoder.player != null) {
            return true;
        }
        return channel.pipeline().get(PacketEvents.DECODER_NAME) instanceof PacketDecoder decoder && decoder.player != null;
    }

    @Override
    public void updateUser(Object channel, User user) {
        if (!(channel instanceof Channel ch)) return;
        if (ch.pipeline().get(PacketEvents.DECODER_NAME) instanceof PacketDecoder decoder) decoder.user = user;
        if (ch.pipeline().get(PacketEvents.ENCODER_NAME) instanceof PacketEncoder encoder) encoder.user = user;
    }

    @Override
    public void setPlayer(Object channel, Object player) {
        if (!(channel instanceof Channel ch)) return;
        if (ch.pipeline().get(PacketEvents.DECODER_NAME) instanceof PacketDecoder decoder) decoder.player = player;
        if (ch.pipeline().get(PacketEvents.ENCODER_NAME) instanceof PacketEncoder encoder) encoder.player = player;
    }

    @Override
    public boolean isProxy() {
        return false;
    }

    @Override
    public PacketSide getPacketSide() {
        return PacketSide.SERVER;
    }
}
