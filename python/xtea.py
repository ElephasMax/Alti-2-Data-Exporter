"""XTEA as used by Alti-2 devices: 16 rounds, delta 0x9E3779B9, little-endian words."""

import struct

DELTA = 0x9E3779B9
MASK = 0xFFFFFFFF
ROUNDS = 16


def _key_words(key: bytes):
    if len(key) != 16:
        raise ValueError("XTEA key must be 16 bytes, got %d" % len(key))
    return struct.unpack("<4I", key)


def encrypt_block(v0: int, v1: int, key_words) -> tuple:
    s = 0
    for _ in range(ROUNDS):
        v0 = (v0 + ((((v1 << 4) ^ (v1 >> 5)) + v1) ^ (s + key_words[s & 3]))) & MASK
        s = (s + DELTA) & MASK
        v1 = (v1 + ((((v0 << 4) ^ (v0 >> 5)) + v0) ^ (s + key_words[(s >> 11) & 3]))) & MASK
    return v0, v1


def decrypt_block(v0: int, v1: int, key_words) -> tuple:
    s = (DELTA * ROUNDS) & MASK
    for _ in range(ROUNDS):
        v1 = (v1 - ((((v0 << 4) ^ (v0 >> 5)) + v0) ^ (s + key_words[(s >> 11) & 3]))) & MASK
        s = (s - DELTA) & MASK
        v0 = (v0 - ((((v1 << 4) ^ (v1 >> 5)) + v1) ^ (s + key_words[s & 3]))) & MASK
    return v0, v1


class XTEA:
    """Block cipher wrapper working on byte strings that are a multiple of 8 bytes."""

    def __init__(self, key: bytes):
        self.key = bytes(key)
        self._kw = _key_words(self.key)

    def encrypt(self, data: bytes) -> bytes:
        if len(data) % 8:
            raise ValueError("data length must be a multiple of 8, got %d" % len(data))
        out = bytearray()
        for off in range(0, len(data), 8):
            v0, v1 = struct.unpack_from("<2I", data, off)
            out += struct.pack("<2I", *encrypt_block(v0, v1, self._kw))
        return bytes(out)

    def decrypt(self, data: bytes) -> bytes:
        if len(data) % 8:
            raise ValueError("data length must be a multiple of 8, got %d" % len(data))
        out = bytearray()
        for off in range(0, len(data), 8):
            v0, v1 = struct.unpack_from("<2I", data, off)
            out += struct.pack("<2I", *decrypt_block(v0, v1, self._kw))
        return bytes(out)
