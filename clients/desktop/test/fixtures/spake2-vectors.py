# Independent SPAKE2 (BoringSSL spake25519) reference over djb's ed25519.py, full-integer scalars.
# Usage: python -I spake2-vectors.py <dir holding ed25519.py>, where ed25519.py is http://ed25519.cr.yp.to/python/ed25519.py
# ported to Python 3 (integer division only). Prints the vectors pinned in test/main/adb-pairing.test.ts.
import sys, hashlib, hmac
sys.path.insert(0, sys.argv[1]); sys.setrecursionlimit(5000)
import ed25519 as E
q, l = E.q, E.l
def dec(s):
    v = int.from_bytes(s, "little"); y = v & ((1 << 255) - 1); x = E.xrecover(y)
    if (x & 1) != (v >> 255): x = q - x
    P = [x, y]; assert E.isoncurve(P); return P
def enc(P): return (P[1] | ((P[0] & 1) << 255)).to_bytes(32, "little")
def neg(P): return [(-P[0]) % q, P[1]]
M = dec(bytes.fromhex("5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e"))
N = dec(bytes.fromhex("10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778"))
def pw_scalar(pw):
    h = hashlib.sha512(pw).digest(); s = int.from_bytes(h, "little") % l
    if s & 1: s += l
    if s & 2: s += 2 * l
    if s & 4: s += 4 * l
    return h, s
def lp(x): return len(x).to_bytes(8, "little") + x
def run(role, rnd, pw, mine, theirs):
    priv = ((int.from_bytes(rnd, "little") % l) << 3) % (1 << 256)
    h, s = pw_scalar(pw)
    msg = enc(E.edwards(E.scalarmult(E.B, priv), E.scalarmult(M if role == "a" else N, s)))
    return priv, h, s, msg
def finish(role, st, pw, mine, theirs, their_msg):
    priv, h, s, msg = st
    Q = E.edwards(dec(their_msg), neg(E.scalarmult(N if role == "a" else M, s)))
    K = enc(E.scalarmult(Q, priv))
    t = lp(mine) + lp(theirs) + lp(msg) + lp(their_msg) if role == "a" else lp(theirs) + lp(mine) + lp(their_msg) + lp(msg)
    return hashlib.sha512(t + lp(K) + lp(h)).digest()
C, S = b"adb pair client\0", b"adb pair server\0"
pw = b"123456" + bytes(range(64))
ra, rb = hashlib.sha512(b"alice").digest(), hashlib.sha512(b"bob").digest()
a = run("a", ra, pw, C, S); b = run("b", rb, pw, S, C)
ka = finish("a", a, pw, C, S, b[3]); kb = finish("b", b, pw, S, C, a[3])
assert ka == kb
wrong = b"654321" + bytes(range(64)); bw = run("b", rb, wrong, S, C)
kaw = finish("a", a, pw, C, S, bw[3])
prk = hmac.new(b"\0" * 32, ka, hashlib.sha256).digest()
okm = hmac.new(prk, b"adb pairing_auth aes-128-gcm key\x01", hashlib.sha256).digest()[:16]
print("alice_msg", a[3].hex()); print("bob_msg", b[3].hex()); print("key", ka.hex())
print("bob_wrong_msg", bw[3].hex()); print("alice_key_vs_wrong", kaw.hex()); print("gcm_key", okm.hex())
