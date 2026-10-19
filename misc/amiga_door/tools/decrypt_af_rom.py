#!/usr/bin/env python3
"""Decrypt an Amiga Forever encrypted ROM (AMIROMTYPE1) into a plain ROM.

Format: 11-byte magic b"AMIROMTYPE1", then the ROM bytes XORed cyclically
with the bytes of rom.key.

usage: decrypt_af_rom.py ENCRYPTED.rom rom.key OUT.rom
"""
import sys
import zlib

MAGIC = b"AMIROMTYPE1"


def decrypt(data: bytes, key: bytes) -> bytes:
    if not data.startswith(MAGIC):
        raise ValueError("not an AMIROMTYPE1 file (bad magic)")
    if not key:
        raise ValueError("empty key")
    body = data[len(MAGIC):]
    klen = len(key)
    # XOR in one big-int operation: fast even for 512 KiB ROMs
    stream = (key * (len(body) // klen + 1))[:len(body)]
    n = int.from_bytes(body, "big") ^ int.from_bytes(stream, "big")
    return n.to_bytes(len(body), "big")


def main(argv):
    if len(argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    enc, keyf, out = argv[1:]
    with open(enc, "rb") as f:
        data = f.read()
    with open(keyf, "rb") as f:
        key = f.read()
    try:
        rom = decrypt(data, key)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    with open(out, "wb") as f:
        f.write(rom)
    print(f"{out}: {len(rom)} bytes, CRC32 {zlib.crc32(rom) & 0xffffffff:08x}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
