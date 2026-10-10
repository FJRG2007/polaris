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

import com.github.retrooper.packetevents.netty.channel.ChannelHelper;
import com.github.retrooper.packetevents.protocol.ProtocolVersion;
import io.github.retrooper.packetevents.impl.netty.manager.protocol.ProtocolManagerAbstract;
import io.netty.buffer.ByteBuf;

/** The Fabric platform's, for the server side only. */
final class NeoForgeProtocolManager extends ProtocolManagerAbstract {

    @Override
    public ProtocolVersion getPlatformVersion() {
        return ProtocolVersion.UNKNOWN;
    }

    @Override
    public void receivePacket(Object channel, Object byteBuf) {
        if (ChannelHelper.isOpen(channel)) {
            if (ChannelHelper.pipelineHandlerNames(channel).contains("decompress")) {
                ChannelHelper.fireChannelReadInContext(channel, "decompress", byteBuf);
            } else {
                ChannelHelper.fireChannelRead(channel, byteBuf);
            }
        } else {
            ((ByteBuf) byteBuf).release();
        }
    }
}
