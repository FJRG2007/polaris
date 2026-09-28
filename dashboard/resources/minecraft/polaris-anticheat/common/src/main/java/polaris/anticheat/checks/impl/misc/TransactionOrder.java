package polaris.anticheat.checks.impl.misc;

import polaris.anticheat.checks.Check;
import polaris.anticheat.checks.CheckData;
import polaris.anticheat.player.PolarisPlayer;

@CheckData(name = "TransactionOrder", stableKey = "polarisac.ping.invalid_transaction_order", description = "Sent transaction or ping responses in an invalid order")
public class TransactionOrder extends Check {
    public TransactionOrder(PolarisPlayer player) {
        super(player);
    }
}
