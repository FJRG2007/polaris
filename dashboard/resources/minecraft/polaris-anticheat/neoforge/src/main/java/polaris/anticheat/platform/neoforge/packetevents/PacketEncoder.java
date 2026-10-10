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

import com.github.retrooper.packetevents.event.PacketSendEvent;
import com.github.retrooper.packetevents.protocol.PacketSide;
import com.github.retrooper.packetevents.protocol.player.User;
import com.github.retrooper.packetevents.util.PacketEventsImplHelper;
import io.netty.buffer.ByteBuf;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelOutboundHandlerAdapter;
import io.netty.channel.ChannelPromise;
import org.jetbrains.annotations.Nullable;

/** What the server sends a player, read after Minecraft encodes it. */
final class PacketEncoder extends ChannelOutboundHandlerAdapter {

    private final PacketSide side;
    User user;
    @Nullable Object player;

    PacketEncoder(PacketSide side, User user) {
        this.side = side;
        this.user = user;
    }

    @Override
    public void write(ChannelHandlerContext ctx, Object msg, ChannelPromise promise) throws Exception {
        if (!(msg instanceof ByteBuf in)) {
            ctx.write(msg, promise);
            return;
        }
        if (!in.isReadable()) {
            in.release();
            promise.trySuccess();
            return;
        }
        PacketSendEvent event = PacketEventsImplHelper.handleClientBoundPacket(ctx.channel(), this.user, this.player, in, false);
        if (!in.isReadable()) {
            in.release();
            promise.trySuccess();
            return;
        }
        if (event != null && event.hasTasksAfterSend()) {
            // The Fabric platform drops these; the engine starts tracking a player from
            // one (after LOGIN_SUCCESS is sent), so they run once the write goes out, as
            // the Bukkit platform runs them.
            ChannelPromise sent = promise.unvoid();
            sent.addListener(done -> {
                for (Runnable task : event.getTasksAfterSend()) task.run();
            });
            ctx.write(in, sent);
            return;
        }
        ctx.write(in, promise);
    }
}
