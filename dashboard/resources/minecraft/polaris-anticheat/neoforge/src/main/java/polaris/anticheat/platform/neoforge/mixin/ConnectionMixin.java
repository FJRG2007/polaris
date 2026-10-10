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
package polaris.anticheat.platform.neoforge.mixin;

import io.netty.channel.ChannelPipeline;
import net.minecraft.network.BandwidthDebugMonitor;
import net.minecraft.network.Connection;
import net.minecraft.network.protocol.PacketFlow;
import org.jetbrains.annotations.Nullable;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import polaris.anticheat.platform.neoforge.packetevents.NeoForgePacketEvents;

/**
 * Where every player's connection gets the handlers the engine reads packets
 * through, as PacketEvents' Fabric platform does it. Optional: when it does not land,
 * no connection is ever read and the engine says so and stays out of the way.
 */
@Mixin(Connection.class)
abstract class ConnectionMixin {

    @Inject(method = "configureSerialization", at = @At("TAIL"), require = 0)
    private static void polarisac$configureSerialization(
            ChannelPipeline pipeline, PacketFlow flow, boolean memoryOnly,
            @Nullable BandwidthDebugMonitor monitor, CallbackInfo ci
    ) {
        try {
            NeoForgePacketEvents.onConfigureSerialization(pipeline, flow, memoryOnly);
        } catch (Throwable failed) {
            // A connection must never fail to open because of the anti-cheat.
            org.slf4j.LoggerFactory.getLogger("PolarisAC").warn("Could not attach to a connection", failed);
        }
    }
}
