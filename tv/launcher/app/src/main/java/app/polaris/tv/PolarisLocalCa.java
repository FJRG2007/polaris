package app.polaris.tv;

import org.json.JSONArray;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.cert.Certificate;
import java.security.cert.CertificateEncodingException;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * Accepting the same Polaris's own local certificate on its local https address, with nothing installed on the
 * TV: this launcher's copy of desktop/src/main/local-ca-pin.ts.
 *
 * A Polaris's local names (polaris.local, its LAN IP) carry a certificate from the instance's own local CA, which
 * the TV does not trust. GET /api/instance publishes that CA's SHA-256, learned only over the usual https address.
 * A chain is accepted only when the usual address is https, the host is one of the instance's other https
 * addresses (never the usual one), the leaf names that host and is not a CA, every certificate is in date, and
 * each one is signed by the next up to a certificate whose SHA-256 is the pin. Everything else keeps the
 * platform's own trust.
 */
final class PolarisLocalCa {

    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    static final int MAX_PINS = 4;
    private static final int MAX_CHAIN = 6;

    private PolarisLocalCa() {
    }

    /** Where the pin applies: the instance's other https hostnames and the CA fingerprints. */
    static final class Scope {
        final Set<String> hosts;
        final List<String> pins;

        Scope(Set<String> hosts, List<String> pins) {
            this.hosts = Collections.unmodifiableSet(hosts);
            this.pins = Collections.unmodifiableList(pins);
        }

        boolean covers(String host) {
            return host != null && hosts.contains(bareHost(host));
        }
    }

    /** The well-formed fingerprints in an answer's localCaSha256, at most a few; empty when absent. */
    static List<String> readPins(JSONArray listed) {
        List<String> pins = new ArrayList<>();
        if (listed == null) return pins;
        for (int i = 0; i < listed.length() && pins.size() < MAX_PINS; i++) {
            String pin = listed.optString(i, "").toLowerCase(Locale.ROOT);
            if (SHA256.matcher(pin).matches() && !pins.contains(pin)) pins.add(pin);
        }
        return pins;
    }

    static String bareHost(String host) {
        String bare = host.trim().toLowerCase(Locale.ROOT);
        return bare.startsWith("[") && bare.endsWith("]") ? bare.substring(1, bare.length() - 1) : bare;
    }

    private static String hostOf(String origin) {
        try {
            String host = new URI(origin).getHost();
            return host == null ? null : bareHost(host);
        } catch (URISyntaxException notAnAddress) {
            return null;
        }
    }

    /**
     * The scope for {@code primary} given what was learned over it, or null when nothing may be accepted: no
     * record, no published CA, or a usual address that is not https (a pin learned over plain http proves nothing).
     */
    static Scope scope(String primary, PolarisFailover.Instance instance) {
        if (primary == null || instance == null || instance.localCaSha256.isEmpty()) return null;
        if (!primary.startsWith("https://")) return null;
        String primaryHost = hostOf(primary);
        if (primaryHost == null) return null;
        Set<String> hosts = new LinkedHashSet<>();
        for (String origin : instance.addresses) {
            if (!origin.startsWith("https://")) continue;
            String host = hostOf(origin);
            if (host != null && !host.isEmpty() && !host.equals(primaryHost)) hosts.add(host);
        }
        return hosts.isEmpty() ? null : new Scope(hosts, new ArrayList<>(instance.localCaSha256));
    }

    static String sha256(X509Certificate cert) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
            StringBuilder out = new StringBuilder(64);
            for (byte b : digest) out.append(String.format(Locale.ROOT, "%02x", b & 0xff));
            return out.toString();
        } catch (NoSuchAlgorithmException | CertificateEncodingException unreadable) {
            return "";
        }
    }

    private static final Pattern IPV4 = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");

    private static boolean isIp(String host) {
        return IPV4.matcher(host).matches() || host.contains(":");
    }

    /** Whether the leaf's subject alternative names cover {@code host}: an exact name, a one-label wildcard, or the IP. */
    static boolean namesHost(X509Certificate leaf, String host) {
        String wanted = bareHost(host);
        Collection<List<?>> names;
        try {
            names = leaf.getSubjectAlternativeNames();
        } catch (CertificateException unreadable) {
            return false;
        }
        if (names == null) return false;
        boolean ip = isIp(wanted);
        for (List<?> entry : names) {
            if (entry.size() < 2 || !(entry.get(0) instanceof Integer) || !(entry.get(1) instanceof String)) continue;
            int type = (Integer) entry.get(0);
            String name = ((String) entry.get(1)).toLowerCase(Locale.ROOT);
            if (ip && type == 7 && sameIp(name, wanted)) return true;
            if (!ip && type == 2 && dnsMatches(name, wanted)) return true;
        }
        return false;
    }

    private static boolean sameIp(String a, String b) {
        if (a.equals(b)) return true;
        try {
            // Both are IP literals here, so no lookup happens.
            return InetAddress.getByName(a).equals(InetAddress.getByName(b));
        } catch (IOException notAnAddress) {
            return false;
        }
    }

    private static boolean dnsMatches(String pattern, String host) {
        if (pattern.endsWith(".")) pattern = pattern.substring(0, pattern.length() - 1);
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        if (!pattern.startsWith("*.")) return pattern.equals(host);
        String suffix = pattern.substring(1);
        if (suffix.indexOf('.', 1) < 0 || !host.endsWith(suffix)) return false;
        String label = host.substring(0, host.length() - suffix.length());
        return !label.isEmpty() && label.indexOf('.') < 0;
    }

    /**
     * Whether {@code chain} (leaf first) is a certificate for {@code host} signed, link by link, up to a CA whose
     * SHA-256 is one of {@code pins}. Signatures are checked here, not taken from the chain's own claims: a leaf of
     * someone else's that merely names the real CA as its issuer fails.
     */
    static boolean chainEndsInPin(X509Certificate[] chain, String host, List<String> pins, Date now) {
        if (chain == null || chain.length == 0 || host == null || pins == null || pins.isEmpty()) return false;
        List<X509Certificate> certs = new ArrayList<>();
        for (X509Certificate cert : chain) {
            if (cert == null || certs.size() >= MAX_CHAIN) break;
            if (!certs.isEmpty() && sha256(certs.get(certs.size() - 1)).equals(sha256(cert))) break;
            certs.add(cert);
        }
        int anchor = -1;
        for (int i = 1; i < certs.size(); i++) {
            if (pins.contains(sha256(certs.get(i)))) {
                anchor = i;
                break;
            }
        }
        if (anchor < 1) return false;
        X509Certificate leaf = certs.get(0);
        if (leaf.getBasicConstraints() >= 0 || !namesHost(leaf, host)) return false;
        try {
            for (int i = 0; i <= anchor; i++) {
                X509Certificate cert = certs.get(i);
                cert.checkValidity(now);
                if (i == anchor) break;
                X509Certificate issuer = certs.get(i + 1);
                if (issuer.getBasicConstraints() < 0
                        || !cert.getIssuerX500Principal().equals(issuer.getSubjectX500Principal())) {
                    return false;
                }
                cert.verify(issuer.getPublicKey());
            }
        } catch (GeneralSecurityException | RuntimeException notChained) {
            return false;
        }
        return true;
    }

    /**
     * A server-side trust check for one host: the platform's own verdict first, and on its refusal the pinned
     * chain. The pin is consulted only for a host the scope covers, which is the only one this is ever built for.
     */
    static class Trust implements X509TrustManager {
        private final X509TrustManager platform;
        private final String host;
        private final List<String> pins;

        Trust(X509TrustManager platform, String host, List<String> pins) {
            this.platform = platform;
            this.host = host;
            this.pins = pins;
        }

        /** Overridden by the tests. */
        Date now() {
            return new Date();
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            try {
                if (platform == null) throw new CertificateException("No platform trust");
                platform.checkServerTrusted(chain, authType);
            } catch (CertificateException refused) {
                if (!chainEndsInPin(chain, host, pins, now())) throw refused;
            }
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("Client certificates are not checked here");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return platform == null ? new X509Certificate[0] : platform.getAcceptedIssuers();
        }
    }

    /** The host check for one host: the platform's verdict, or a peer chain that ends in the pin and names the host. */
    static final class Names implements HostnameVerifier {
        private final HostnameVerifier platform;
        private final Scope scope;

        Names(HostnameVerifier platform, Scope scope) {
            this.platform = platform;
            this.scope = scope;
        }

        @Override
        public boolean verify(String hostname, SSLSession session) {
            if (platform != null && platform.verify(hostname, session)) return true;
            if (!scope.covers(hostname)) return false;
            try {
                Certificate[] peer = session.getPeerCertificates();
                X509Certificate[] chain = new X509Certificate[peer.length];
                for (int i = 0; i < peer.length; i++) {
                    if (!(peer[i] instanceof X509Certificate)) return false;
                    chain[i] = (X509Certificate) peer[i];
                }
                return chainEndsInPin(chain, bareHost(hostname), scope.pins, new Date());
            } catch (SSLPeerUnverifiedException unverified) {
                return false;
            }
        }
    }

    private static X509TrustManager platformTrust() throws GeneralSecurityException {
        TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        factory.init((KeyStore) null);
        for (TrustManager manager : factory.getTrustManagers()) {
            if (manager instanceof X509TrustManager) return (X509TrustManager) manager;
        }
        throw new GeneralSecurityException("No platform X509TrustManager");
    }

    /** A socket factory that trusts the platform's roots and, for {@code host} only, a chain ending in the pin. */
    static SSLSocketFactory socketFactory(String host, Scope scope) throws GeneralSecurityException {
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[] {new Trust(platformTrust(), bareHost(host), scope.pins)}, null);
        return context.getSocketFactory();
    }

    /**
     * Applies the pinned trust to a connection bound for one of the scope's hosts; any other connection, the usual
     * address's included, is left on the platform default untouched.
     */
    static void apply(HttpURLConnection connection, Scope scope) throws IOException {
        if (scope == null || !(connection instanceof HttpsURLConnection)) return;
        String host = connection.getURL().getHost();
        if (!scope.covers(host)) return;
        HttpsURLConnection https = (HttpsURLConnection) connection;
        try {
            https.setSSLSocketFactory(socketFactory(host, scope));
        } catch (GeneralSecurityException unavailable) {
            throw new IOException("TLS is unavailable", unavailable);
        }
        https.setHostnameVerifier(new Names(HttpsURLConnection.getDefaultHostnameVerifier(), scope));
    }
}
