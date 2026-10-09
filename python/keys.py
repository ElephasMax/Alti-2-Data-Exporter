"""Encryption key derivation for Alti-2 devices.

The 16-byte XTEA key is built from three product-specific code bytes and bytes
of the (unencrypted) Info message.  Index numbers below are positions in the
full 32-byte Info message (0 = length byte), i.e. the numbering used by the
Alti-2 atlas2-communications documentation.

Two different key layouts exist:

* ``SCHEDULE_DOC`` is the layout published by Alti-2, used by Neptune III,
  Atlas, Atlas 2 and MA-12 devices.
* ``SCHEDULE_LEGACY`` is used by Neptune II and Neptune IIIA.

Product code sets, from observed devices and the Alti-2 docs:

==================  ==============  ==========================================
name                codes           used for
==================  ==============  ==========================================
legacy              4E 75 7E        Neptune II / IIIA; "Atlas" (docs)
atlas1              38 99 CF        Atlas / MA-12 with Info byte 2 == 4
atlas2              AA 69 44        Info byte 2 == 5: Neptune III, Atlas, Atlas 2, MA-12
juno                8D AF 11        Juno (docs only, not seen on a device)
==================  ==============  ==========================================

Because the labelling differs between the two sources, :func:`key_candidates`
returns an ordered list of keys to try; the device layer verifies each one
with a harmless read before using it.
"""

PRODUCT_CODES = {
    "atlas2": (0xAA, 0x69, 0x44),
    "atlas1": (0x38, 0x99, 0xCF),
    "legacy": (0x4E, 0x75, 0x7E),
    "juno": (0x8D, 0xAF, 0x11),
}

# Each entry is either an int (Info message index) or 'c0'/'c1'/'c2' (product code).
SCHEDULE_DOC = ["c0", 23, 6, 13, 24, 22, 12, "c1", 7, 8, 10, "c2", 9, 11, 26, 25]
SCHEDULE_LEGACY = ["c0", 8, 26, 24, 6, 25, 23, 13, 10, "c1", 7, 22, 9, 11, "c2", 21]

SCHEDULES = {"doc": SCHEDULE_DOC, "legacy": SCHEDULE_LEGACY}


def build_key(info: bytes, codes, schedule) -> bytes:
    """Build the 16 byte key from a 32 byte Info message, 3 code bytes and a schedule."""
    if len(info) < 31:
        raise ValueError("Info message too short (%d bytes)" % len(info))
    c = {"c0": codes[0], "c1": codes[1], "c2": codes[2]}
    out = bytearray(16)
    for i, src in enumerate(schedule):
        out[i] = c[src] if isinstance(src, str) else info[src]
    return bytes(out)


def key_candidates(info: bytes):
    """Return [(label, key_bytes), ...] ordered from most to least likely.

    The order starts with the most likely layout for the device family reported in
    Info byte 2, then falls back to the documented layouts and finally to
    every remaining combination.
    """
    family = info[2]
    product = info[15]
    order = []
    if family == 5:
        order.append(("atlas2", "doc"))
    elif family == 4:
        order.append(("atlas1", "doc"))
        order.append(("legacy", "doc"))      # documented "Atlas" codes
    elif family in (2, 3):
        order.append(("legacy", "legacy"))
        if family == 3 and product != 6:
            order.append(("atlas2", "doc"))
    # documented layouts
    order += [("legacy", "doc"), ("atlas2", "doc"), ("juno", "doc")]
    # everything else
    for codes in PRODUCT_CODES:
        for sched in SCHEDULES:
            order.append((codes, sched))
    seen = set()
    result = []
    for codes, sched in order:
        if (codes, sched) in seen:
            continue
        seen.add((codes, sched))
        result.append(("%s/%s" % (codes, sched), build_key(info, PRODUCT_CODES[codes], SCHEDULES[sched])))
    return result


def parse_key_override(text: str):
    """Turn a CLI override into candidate list entries.

    Accepts a 32 hex digit key, or three code bytes like 'AA,69,44' / 'AA6944'
    (both schedules are generated for code bytes).
    """
    t = text.replace(" ", "").replace(",", "").replace(":", "")
    if len(t) == 32:
        return [("manual", bytes.fromhex(t))]
    if len(t) == 6:
        return [("codes-%s/%s" % (t.upper(), name), None, bytes.fromhex(t), sched) for name, sched in SCHEDULES.items()]
    raise ValueError("expected 32 hex digits (full key) or 6 hex digits (3 product codes)")


def candidates_with_override(info: bytes, override: str):
    """Candidates for key_candidates() with a user supplied key or code set tried first."""
    first = []
    for entry in parse_key_override(override):
        if len(entry) == 2:
            first.append(entry)
        else:
            label, _, codes, sched = entry
            first.append((label, build_key(info, tuple(codes), sched)))
    rest = [c for c in key_candidates(info) if c[1] not in {k for _, k in first}]
    return first + rest
