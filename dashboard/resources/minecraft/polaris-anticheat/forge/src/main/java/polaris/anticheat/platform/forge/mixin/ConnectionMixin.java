/*
 * This file is part of packetevents - https://github.com/retrooper/packetevents
 * Copyright (C) 2024 retrooper and contributors
 *
 * Carried over from packetevents' Fabric platform (v2.14.0) to Forge by Polaris.
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
package polaris.anticheat.platform.forge.mixin;

import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.local.LocalChannel;
import net.minecraft.network.Connection;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import polaris.anticheat.platform.forge.packetevents.ForgePacketEvents;

/**
 * Where every player's connection gets the handlers the engine reads packets
 * through. Minecraft 1.20.1 builds a connection's pipeline in the server's channel
 * initializer and only then activates the {@link Connection} at its end, so the
 * handlers go on when it becomes active, and move behind the compression handlers
 * once those are added. Optional: when it does not land, no connection is ever
 * read and the engine says so and stays out of the way.
 */
@Mixin(Connection.class)
abstract class ConnectionMixin {

    @Inject(method = "channelActive", at = @At("TAIL"), require = 0)
    private void polarisac$channelActive(ChannelHandlerContext ctx, CallbackInfo ci) {
        try {
            Connection self = (Connection) (Object) this;
            ForgePacketEvents.onConfigureSerialization(ctx.pipeline(), self.getReceiving(),
                    ctx.channel() instanceof LocalChannel);
        } catch (Throwable failed) {
            // A connection must never fail to open because of the anti-cheat.
            org.slf4j.LoggerFactory.getLogger("PolarisAC").warn("Could not attach to a connection", failed);
        }
    }

    @Inject(method = "setupCompression", at = @At("TAIL"), require = 0)
    private void polarisac$setupCompression(int threshold, boolean validate, CallbackInfo ci) {
        try {
            ForgePacketEvents.onCompression(((Connection) (Object) this).channel().pipeline());
        } catch (Throwable failed) {
            org.slf4j.LoggerFactory.getLogger("PolarisAC").warn("Could not follow a connection's compression", failed);
        }
    }
}
