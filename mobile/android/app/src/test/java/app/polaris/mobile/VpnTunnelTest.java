package app.polaris.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class VpnTunnelTest {
    @Test
    public void aBareAddressIsOneHost() {
        assertEquals("10.128.0.2/32", VpnTunnel.withPrefix("10.128.0.2"));
        assertEquals("fd00::2/128", VpnTunnel.withPrefix("fd00::2"));
    }

    @Test
    public void anAddressWithItsPrefixIsKept() {
        assertEquals("10.8.0.2/24", VpnTunnel.withPrefix("10.8.0.2/24"));
    }

    @Test
    public void anEndpointNamesItsPort() {
        assertEquals("vpn.example.com:51820", VpnTunnel.endpoint("vpn.example.com", 51820));
        assertEquals("203.0.113.7:51820", VpnTunnel.endpoint("203.0.113.7", 51820));
    }

    @Test
    public void anIpv6EndpointIsBracketed() {
        assertEquals("[2001:db8::1]:51820", VpnTunnel.endpoint("2001:db8::1", 51820));
        assertEquals("[2001:db8::1]:51820", VpnTunnel.endpoint("[2001:db8::1]", 51820));
    }
}
