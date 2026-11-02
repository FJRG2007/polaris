package app.polaris.tv;

import java.math.BigInteger;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;

/**
 * Ed25519 signature verification (RFC 8032, section 5.1.7).
 *
 * minSdk is 26 and the platform only offers Ed25519 from API 33, so the check that tells this Polaris from a
 * look-alike on the network is written out here. Public data only: nothing secret goes through it, so the
 * variable time of BigInteger does not matter. Slow on a TV CPU; call it off the main thread.
 */
final class PolarisEd25519 {

    private static final BigInteger P = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19));
    private static final BigInteger L = BigInteger.ONE.shiftLeft(252)
            .add(new BigInteger("27742317777372353535851937790883648493"));
    private static final BigInteger TWO = BigInteger.valueOf(2);
    private static final BigInteger D = BigInteger.valueOf(-121665)
            .multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P);
    private static final BigInteger SQRT_M1 = TWO.modPow(P.subtract(BigInteger.ONE).shiftRight(2), P);
    /** The base point: y = 4/5, x even. */
    private static final BigInteger[] BASE = decompress(BigInteger.valueOf(4)
            .multiply(BigInteger.valueOf(5).modInverse(P)).mod(P), false);

    private PolarisEd25519() { }

    /** Whether {@code signature} is the holder of {@code publicKey}'s over {@code message}. Never throws. */
    static boolean verify(byte[] publicKey, byte[] message, byte[] signature) {
        if (publicKey == null || signature == null || publicKey.length != 32 || signature.length != 64) return false;
        BigInteger[] a = decode(publicKey);
        byte[] rBytes = Arrays.copyOfRange(signature, 0, 32);
        BigInteger[] r = decode(rBytes);
        if (a == null || r == null) return false;
        BigInteger s = littleEndian(Arrays.copyOfRange(signature, 32, 64));
        if (s.compareTo(L) >= 0) return false;
        BigInteger h;
        try {
            MessageDigest sha512 = MessageDigest.getInstance("SHA-512");
            sha512.update(rBytes);
            sha512.update(publicKey);
            h = littleEndian(sha512.digest(message)).mod(L);
        } catch (NoSuchAlgorithmException absent) {
            return false;
        }
        return same(multiply(BASE, s), add(r, multiply(a, h)));
    }

    private static BigInteger littleEndian(byte[] bytes) {
        byte[] big = new byte[bytes.length];
        for (int i = 0; i < bytes.length; i++) big[i] = bytes[bytes.length - 1 - i];
        return new BigInteger(1, big);
    }

    /** A point from its 32 bytes, or null when they are not one. */
    private static BigInteger[] decode(byte[] encoded) {
        boolean negative = (encoded[31] & 0x80) != 0;
        byte[] copy = encoded.clone();
        copy[31] &= 0x7F;
        BigInteger y = littleEndian(copy);
        return y.compareTo(P) >= 0 ? null : decompress(y, negative);
    }

    /** Extended coordinates (X, Y, Z, T) of the point with this y, or null when none exists. */
    private static BigInteger[] decompress(BigInteger y, boolean negative) {
        BigInteger y2 = y.multiply(y).mod(P);
        BigInteger u = y2.subtract(BigInteger.ONE).mod(P);
        BigInteger v = D.multiply(y2).add(BigInteger.ONE).mod(P);
        BigInteger x2 = u.multiply(v.modInverse(P)).mod(P);
        if (x2.signum() == 0) {
            if (negative) return null;
            return new BigInteger[] {BigInteger.ZERO, y, BigInteger.ONE, BigInteger.ZERO};
        }
        BigInteger x = x2.modPow(P.add(BigInteger.valueOf(3)).shiftRight(3), P);
        if (!x.multiply(x).subtract(x2).mod(P).equals(BigInteger.ZERO)) x = x.multiply(SQRT_M1).mod(P);
        if (!x.multiply(x).subtract(x2).mod(P).equals(BigInteger.ZERO)) return null;
        if (x.testBit(0) != negative) x = P.subtract(x);
        return new BigInteger[] {x, y, BigInteger.ONE, x.multiply(y).mod(P)};
    }

    private static BigInteger[] add(BigInteger[] p, BigInteger[] q) {
        BigInteger a = p[1].subtract(p[0]).multiply(q[1].subtract(q[0])).mod(P);
        BigInteger b = p[1].add(p[0]).multiply(q[1].add(q[0])).mod(P);
        BigInteger c = TWO.multiply(p[3]).multiply(q[3]).multiply(D).mod(P);
        BigInteger d = TWO.multiply(p[2]).multiply(q[2]).mod(P);
        BigInteger e = b.subtract(a);
        BigInteger f = d.subtract(c);
        BigInteger g = d.add(c);
        BigInteger h = b.add(a);
        return new BigInteger[] {
            e.multiply(f).mod(P), g.multiply(h).mod(P), f.multiply(g).mod(P), e.multiply(h).mod(P)
        };
    }

    private static BigInteger[] multiply(BigInteger[] point, BigInteger scalar) {
        BigInteger[] sum = {BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO};
        BigInteger[] doubling = point;
        for (int bit = 0; bit < scalar.bitLength(); bit++) {
            if (scalar.testBit(bit)) sum = add(sum, doubling);
            doubling = add(doubling, doubling);
        }
        return sum;
    }

    /** Compares projectively, so neither side needs an inversion. */
    private static boolean same(BigInteger[] p, BigInteger[] q) {
        return p[0].multiply(q[2]).subtract(q[0].multiply(p[2])).mod(P).signum() == 0
                && p[1].multiply(q[2]).subtract(q[1].multiply(p[2])).mod(P).signum() == 0;
    }
}
