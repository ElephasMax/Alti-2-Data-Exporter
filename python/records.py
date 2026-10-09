"""Jump log record formats of Alti-2 Neptune II/III, Atlas and Atlas 2 devices.

Values are kept exactly as the device stores them: altitudes in meters (16 m resolution in the
summary record, 4 m for ground elevation), times in seconds, true air speeds (``tas_*``) in m/s.
The altitude fields are named ``*_ft`` for historical reasons; see ``units.py`` for conversion.
"""

import struct
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import List, Optional, Tuple

SUMMARY_RECORD_SIZE = 22
PROFILE_RECORD_SIZE = 224
JUMP_COUNT_ADDRESS = 14          # uint16 LE: number of summary records in the log
NAME_TABLE_SIZE = 322
NAME_TABLES = {"jump_types": 728, "aircraft": 406, "dropzones": 84}   # EEPROM addresses ("Alarms", "Aircraft", "Dropzones")


@dataclass
class SummaryRecord:
    jump_no: int
    date: Optional[datetime]
    exit_alt_ft: int
    deploy_alt_ft: int
    freefall_time_s: int
    canopy_time_s: int
    ground_alt_ft: int
    tas_3k: int
    tas_6k: int
    tas_9k: int
    tas_12k: int
    jump_type_idx: int
    jump_type_custom: bool
    aircraft_idx: int
    dropzone_idx: int
    profile_slot: int
    deleted: bool
    fw_version: str
    raw_words: List[int] = field(default_factory=list, repr=False)

    @property
    def fw_tuple(self):
        return tuple(int(x) for x in self.fw_version.split("."))


def parse_summary(data: bytes, new_epoch: bool, month_offset: int = 0) -> SummaryRecord:
    """Parse one 22 byte summary record.

    new_epoch: True for devices whose Info byte 2 == 5 (Atlas 2 era) which count
    months from January 2015; older devices count from January 2007.
    """
    if len(data) < SUMMARY_RECORD_SIZE:
        raise ValueError("summary record needs 22 bytes, got %d" % len(data))
    w = list(struct.unpack("<11H", data[:22]))
    months = (w[1] & 0x7F) - 1
    base_year = 2015 if new_epoch else 2007
    year = base_year + months // 12
    month = months % 12 + 1 + month_offset
    day = (w[6] & 0x7C00) >> 10
    hour = (w[3] & 0x7C0) >> 6
    minute = w[3] & 0x3F
    try:
        date = datetime(year, month, day, hour, minute)
    except ValueError:
        date = None
    tas = ((w[5] & 0xFFF) << 16) | w[4]
    fw = "%d.%d.%d" % (w[10] & 0xF, (w[3] & 0x7800) >> 11, (w[2] & 0xFC00) >> 10)
    return SummaryRecord(
        jump_no=w[0],
        date=date,
        exit_alt_ft=(w[6] & 0x3FF) * 16,
        deploy_alt_ft=(w[7] & 0x3FF) * 16,
        freefall_time_s=w[2] & 0x3FF,
        canopy_time_s=w[8] & 0xFFF,
        ground_alt_ft=(w[9] & 0x3FF) * 4 - 640,
        tas_3k=tas & 0x7F,
        tas_6k=(tas >> 7) & 0x7F,
        tas_9k=(tas >> 14) & 0x7F,
        tas_12k=(tas >> 21) & 0x7F,
        jump_type_idx=(w[1] & 0x1F00) >> 8,
        jump_type_custom=bool(w[1] & 0x8000),
        aircraft_idx=((w[3] & 0x8000) >> 11) | ((w[5] & 0xF000) >> 12),
        dropzone_idx=(w[7] & 0x7C00) >> 10,
        profile_slot=((w[8] & 0xC000) >> 8) | ((w[9] & 0xFC00) >> 10),
        deleted=bool(w[1] & 0x80),
        fw_version=fw,
        raw_words=w,
    )


def encode_summary(rec: SummaryRecord, new_epoch: bool) -> bytes:
    """Inverse of parse_summary (used by the device simulator and tests)."""
    base_year = 2015 if new_epoch else 2007
    d = rec.date or datetime(base_year, 1, 1)
    months = (d.year - base_year) * 12 + (d.month - 1) + 1
    major, minor, patch = rec.fw_tuple
    tas = (rec.tas_3k & 0x7F) | ((rec.tas_6k & 0x7F) << 7) | ((rec.tas_9k & 0x7F) << 14) | ((rec.tas_12k & 0x7F) << 21)
    w = [0] * 11
    w[0] = rec.jump_no & 0xFFFF
    w[1] = (months & 0x7F) | (0x80 if rec.deleted else 0) | ((rec.jump_type_idx & 0x1F) << 8) | (0x8000 if rec.jump_type_custom else 0)
    w[2] = (rec.freefall_time_s & 0x3FF) | ((patch & 0x3F) << 10)
    w[3] = (d.minute & 0x3F) | ((d.hour & 0x1F) << 6) | ((minor & 0xF) << 11) | (((rec.aircraft_idx >> 4) & 1) << 15)
    w[4] = tas & 0xFFFF
    w[5] = ((tas >> 16) & 0xFFF) | ((rec.aircraft_idx & 0xF) << 12)
    w[6] = ((rec.exit_alt_ft // 16) & 0x3FF) | ((d.day & 0x1F) << 10)
    w[7] = ((rec.deploy_alt_ft // 16) & 0x3FF) | ((rec.dropzone_idx & 0x1F) << 10)
    w[8] = (rec.canopy_time_s & 0xFFF) | (((rec.profile_slot >> 6) & 0x3) << 14)
    w[9] = (((rec.ground_alt_ft + 640) // 4) & 0x3FF) | ((rec.profile_slot & 0x3F) << 10)
    w[10] = major & 0xF
    return struct.pack("<11H", *w)


@dataclass
class Profile:
    """Freefall altitude profile: (time_s, altitude_ft) points, time relative to freefall start."""
    jump_no: int
    freefall_start_s: float
    points: List[Tuple[float, int]]

    def as_dict(self):
        return {"jump_no": self.jump_no, "freefall_start_s": self.freefall_start_s,
                "points": [[t, a] for t, a in self.points]}


def _s8(v):
    return v - 256 if v & 0x80 else v


def parse_profile(data: bytes) -> Profile:
    """Decode a 224 byte detailed record.

    Layout (little-endian 16 bit words):
      w0 = freefall start time * 4 (0xFFFF -> 60 s), w1 = jump number,
      w2 = first altitude (ft), w3 = first time * 4, then a stream of codes
      in the top nibble of each word:
        0-7  delta: time += int8(hi byte)/4, altitude -= int8(lo byte)
        8    no-op
        9    absolute: altitude = w & 0xFFF, time = next word / 4   (also 13, 14, others)
        10   absolute, altitude * 2
        11   absolute, altitude * 4
        12   absolute, negative altitude (12 bit two's complement)
        15   end of record
    Times are then made relative to freefall start; points earlier than -30 s are dropped.
    """
    if len(data) % 2:
        raise ValueError("profile record length must be even")
    w = list(struct.unpack("<%dH" % (len(data) // 2), data))
    if len(w) < 4:
        raise ValueError("profile record too short")
    ff_start = 60.0 if w[0] == 0xFFFF else w[0] / 4.0
    jump_no = w[1]
    raw = []
    t = w[3] / 4.0
    alt = w[2]
    raw.append((t, alt))
    i = 4
    while i < len(w):
        code = (w[i] & 0xF000) >> 12
        if code <= 7:
            t += _s8(w[i] >> 8) / 4.0
            alt -= _s8(w[i] & 0xFF)
            raw.append((t, alt))
            i += 1
        elif code == 8:
            i += 1
        elif code == 15:
            break
        else:
            if i + 1 >= len(w):
                break
            t = w[i + 1] / 4.0
            v = w[i] & 0xFFF
            if code == 10:
                alt = v * 2
            elif code == 11:
                alt = v * 4
            elif code == 12:
                alt = v - 0x1000
            else:
                alt = v
            raw.append((t, alt))
            i += 2
    # drop consecutive points with identical time, then re-base time
    points = []
    last_t = None
    for t, a in raw:
        if last_t is not None and t == last_t:
            continue
        last_t = t
        rel = round((t - ff_start) * 100.0) / 100.0
        if rel < -30.0:
            continue
        points.append((rel, a))
    return Profile(jump_no=jump_no, freefall_start_s=ff_start, points=points)


def encode_profile(jump_no: int, freefall_start_s: float, points: List[Tuple[float, int]]) -> bytes:
    """Encode absolute (time_s, altitude_ft) points into a 224 byte detailed record."""
    w = [int(round(freefall_start_s * 4)) & 0xFFFF, jump_no & 0xFFFF]
    if not points:
        points = [(0.0, 0)]
    t0, a0 = points[0]
    w += [a0 & 0xFFFF, int(round(t0 * 4)) & 0xFFFF]
    prev_t, prev_a = round(t0 * 4), a0
    for t, a in points[1:]:
        qt = int(round(t * 4))
        dt, da = qt - prev_t, prev_a - a
        if 0 <= dt <= 127 and -128 <= da <= 127:
            w.append((dt << 8) | (da & 0xFF))
        else:
            if a < 0:
                w += [0xC000 | (a & 0xFFF), qt & 0xFFFF]
            elif a < 0x1000:
                w += [0x9000 | a, qt & 0xFFFF]
            elif a < 0x2000:
                w += [0xA000 | (a // 2), qt & 0xFFFF]
                a = (a // 2) * 2
            elif a < 0x4000:
                w += [0xB000 | (a // 4), qt & 0xFFFF]
                a = (a // 4) * 4
            else:
                raise ValueError("altitude %d ft cannot be encoded (max 16380)" % a)
        prev_t, prev_a = qt, a
    w.append(0xF000)
    if len(w) > PROFILE_RECORD_SIZE // 2:
        raise ValueError("profile does not fit in %d bytes" % PROFILE_RECORD_SIZE)
    w += [0x8000] * (PROFILE_RECORD_SIZE // 2 - len(w))
    return struct.pack("<%dH" % len(w), *w)


@dataclass
class NameEntry:
    name: str
    flag_a: bool    # byte 1 bit 7
    flag_b: bool    # byte 0 bit 7


def parse_name_table(data: bytes) -> List[NameEntry]:
    """Parse one of the 322 byte name tables (jump types, aircraft, dropzones).

    Byte 0 is a checksum (sum of bytes 1..321 plus 1, modulo 256), byte 1 the
    number of entries, then up to 32 entries of 10 bytes (7-bit ASCII, NUL padded).
    """
    if len(data) < 2:
        raise ValueError("name table too short")
    count = data[1]
    entries = []
    for i in range(min(count, 32)):
        chunk = data[2 + i * 10:12 + i * 10]
        if len(chunk) < 10:
            break
        name = ""
        for b in chunk:
            c = b & 0x7F
            if c == 0:
                break
            name += chr(c)
        entries.append(NameEntry(name.strip(), bool(chunk[1] & 0x80), bool(chunk[0] & 0x80)))
    return entries


def name_table_checksum(data: bytes) -> int:
    return (1 + sum(data[1:NAME_TABLE_SIZE])) & 0xFF


def encode_name_table(names) -> bytes:
    buf = bytearray(NAME_TABLE_SIZE)
    buf[1] = len(names)
    for i, n in enumerate(names[:32]):
        raw = n.encode("ascii", "replace")[:10]
        buf[2 + i * 10:2 + i * 10 + len(raw)] = raw
    buf[0] = name_table_checksum(bytes(buf))
    return bytes(buf)


def summary_to_dict(rec: SummaryRecord):
    d = asdict(rec)
    d.pop("raw_words", None)
    d["date"] = rec.date.isoformat(timespec="minutes") if rec.date else None
    return d
