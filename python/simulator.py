"""A software model of an Alti-2 device, used for tests and for trying the tool without hardware.

It speaks the same wire protocol as the real device over any file descriptor
(normally the master side of a pseudo terminal).
"""

import os
import select
import struct
import threading
import time
from datetime import datetime, timedelta
from typing import List, Optional, Tuple

from . import keys as _keys
from .protocol import (CMD_EXIT, CMD_KEEP_ALIVE, CMD_READ_EEPROM, CMD_READ_INFO_MEM, CMD_READ_TIME,
                       CMD_SET_TIME, PACKET_SIZE, encode_time, decode_time)
from .records import (JUMP_COUNT_ADDRESS, NAME_TABLES, PROFILE_RECORD_SIZE, SUMMARY_RECORD_SIZE,
                      SummaryRecord, encode_name_table, encode_profile, encode_summary)
from .xtea import XTEA

MODELS = {
    # name: (family byte, product id, codes, schedule)
    "atlas2": (5, 12, "atlas2", "doc"),
    "atlas": (4, 7, "atlas1", "doc"),
    "atlas-newfw": (5, 7, "atlas2", "doc"),
    "neptune3": (3, 5, "legacy", "legacy"),
    "neptune3-newfw": (5, 5, "atlas2", "doc"),
    "neptune2": (2, 1, "legacy", "legacy"),
    "ma12": (4, 8, "atlas1", "doc"),
}


def build_info(family, product, serial="23007423", version=(1, 0, 9), hardware_id=1, fram=1,
               detailed_addr=0x12000, total_jumps=0, total_seconds=0, summary_addr=0x520) -> bytes:
    raw = bytearray(32)
    raw[0] = 0x1E
    raw[1] = 0x00
    raw[2] = family
    raw[3] = ((version[0] & 0xF) << 4) | (version[1] & 0xF)
    raw[4] = version[2]
    s = serial.encode("ascii")[:9].ljust(9, b" ")
    raw[5:14] = s
    raw[14] = hardware_id
    raw[15] = product
    raw[16] = fram
    struct.pack_into("<I", raw, 17, detailed_addr)
    struct.pack_into("<H", raw, 21, total_jumps)
    struct.pack_into("<I", raw, 23, total_seconds)
    struct.pack_into("<I", raw, 27, summary_addr)
    raw[31] = sum(raw[1:31]) & 0xFF
    return bytes(raw)


def sample_profile(exit_alt=13000, deploy_alt=3500, freefall_s=45, step=0.75) -> Tuple[float, List[Tuple[float, int]]]:
    """Generate a plausible (absolute time, altitude) profile that fits a 224 byte record.

    Returns (freefall_start, points).  The record holds at most 108 words, so
    the sample uses 0.75 s steps in freefall and a handful of canopy points.
    """
    ff_start = 20.0
    pts = [(0.0, exit_alt), (8.0, exit_alt), (16.0, exit_alt)]
    alt = float(exit_alt)
    v = 0.0
    t = ff_start
    pts.append((t, exit_alt))
    while alt > deploy_alt and t < ff_start + freefall_s:
        v = min(150.0, v + 32.0 * step)
        alt -= v * step
        t += step
        pts.append((t, int(alt)))
    for _ in range(8):           # under canopy: 120 ft every 10 s
        alt -= 120
        t += 10.0
        pts.append((t, max(0, int(alt))))
    return ff_start, pts


def sample_jumps(n, new_epoch, start=None) -> List[Tuple[SummaryRecord, float, List[Tuple[float, int]]]]:
    # the 7 bit month counter covers ~10.6 years from the epoch (2007 or 2015)
    start = start or (datetime(2024, 5, 4, 9, 30) if new_epoch else datetime(2014, 5, 4, 9, 30))
    out = []
    for i in range(n):
        exit_alt = 12800 + (i % 3) * 800
        deploy = 3200 + (i % 2) * 400
        ff = 40 + i % 10
        ffs, pts = sample_profile(exit_alt, deploy, ff)
        rec = SummaryRecord(
            jump_no=1000 + i, date=start + timedelta(days=i // 4, hours=(i % 4) * 2),
            exit_alt_ft=exit_alt, deploy_alt_ft=deploy, freefall_time_s=ff, canopy_time_s=180 + i,
            ground_alt_ft=600, tas_3k=50 + i % 5, tas_6k=52, tas_9k=54, tas_12k=55,
            jump_type_idx=i % 4, jump_type_custom=False, aircraft_idx=i % 3, dropzone_idx=i % 2,
            profile_slot=i, deleted=(i == 2), fw_version="1.0.9" if new_epoch else "2.1.3")
        out.append((rec, ffs, pts))
    return out


class SimulatedDevice:
    def __init__(self, model="atlas2", jumps=None, serial="23007423", key_override=None,
                 tables=None, log=None):
        family, product, codes, sched = MODELS[model]
        self.model = model
        self.family = family
        self.new_epoch = family == 5
        self.log = log or (lambda m: None)
        self.summary_addr = 0x520
        self.detailed_addr = 0x12000
        self.jumps = jumps if jumps is not None else sample_jumps(5, self.new_epoch)
        total_seconds = sum(j[0].freefall_time_s for j in self.jumps)
        self.info = build_info(family, product, serial=serial, total_jumps=len(self.jumps),
                               total_seconds=total_seconds, detailed_addr=self.detailed_addr,
                               summary_addr=self.summary_addr)
        if key_override is not None:
            self.key = key_override
        else:
            self.key = _keys.build_key(self.info, _keys.PRODUCT_CODES[codes], _keys.SCHEDULES[sched])
        self.cipher = XTEA(self.key)
        self.clock_offset = timedelta(0)
        self.memory = bytearray(0x40000)
        tables = tables or {"jump_types": ["FrEE", "AFF", "TAN", "STU", "PHO", "SLO"],
                            "aircraft": ["Otter", "Caravan", "C182"],
                            "dropzones": ["Eloy", "Perris"]}
        for name, addr in NAME_TABLES.items():
            self.memory[addr:addr + 322] = encode_name_table(tables.get(name, []))
        struct.pack_into("<H", self.memory, JUMP_COUNT_ADDRESS, len(self.jumps))
        for i, (rec, ffs, pts) in enumerate(self.jumps):
            self.memory[self.summary_addr + i * SUMMARY_RECORD_SIZE:self.summary_addr + (i + 1) * SUMMARY_RECORD_SIZE] = \
                encode_summary(rec, self.new_epoch)
            # slot's jump number field holds the record index (what the downloader checks against)
            prof = encode_profile(i, ffs, pts)
            base = self.detailed_addr + rec.profile_slot * PROFILE_RECORD_SIZE
            self.memory[base:base + PROFILE_RECORD_SIZE] = prof
        self.set_time_calls = []
        self.exited = False

    # -- serving -----------------------------------------------------------
    def serve_fd(self, fd, stop: Optional[threading.Event] = None):
        """Serve the protocol on a raw file descriptor until stop is set or the peer goes away."""
        wake = b""
        while not (stop and stop.is_set()):
            r, _, _ = select.select([fd], [], [], 0.2)
            if not r:
                continue
            try:
                data = os.read(fd, 64)
            except OSError:
                break
            if not data:
                break
            wake += data
            if len(wake) >= 6:
                wake = b""
                self.log("sim: wake-up received, sending info")
                time.sleep(0.05)
                os.write(fd, (" ".join("%02X" % b for b in self.info) + "\r\n").encode())
                self._session(fd, stop)

    def _read_exact(self, fd, n, timeout=10.0):
        out = bytearray()
        deadline = time.monotonic() + timeout
        while len(out) < n:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            r, _, _ = select.select([fd], [], [], remaining)
            if not r:
                continue
            chunk = os.read(fd, n - len(out))
            if not chunk:
                return None
            out += chunk
        return bytes(out)

    def _session(self, fd, stop):
        while not (stop and stop.is_set()):
            pkt = self._read_exact(fd, PACKET_SIZE, timeout=30.0)
            if pkt is None:
                self.log("sim: session timeout")
                return
            plain = self.cipher.decrypt(pkt)
            n = plain[0]
            if n > 30:
                self.log("sim: length error (wrong key?)")
                os.write(fd, b"\x32")
                continue
            payload = plain[1:1 + n]
            if (sum(payload) & 0xFF) != plain[1 + n]:
                self.log("sim: checksum error")
                os.write(fd, b"\x33")
                continue
            os.write(fd, b"\x31")
            if not payload:
                os.write(fd, b"\x37")
                continue
            cmd = payload[0]
            if cmd in (CMD_READ_EEPROM, CMD_READ_INFO_MEM):
                addr, length = struct.unpack_from("<IH", payload, 1)
                self.log("sim: read 0x%X len %d" % (addr, length))
                os.write(fd, b"\x35")
                if not self._send_read(fd, addr, length):
                    return
            elif cmd == CMD_SET_TIME:
                dt = decode_time(payload[1:9])
                self.clock_offset = dt - datetime.now()
                self.set_time_calls.append(dt)
                self.log("sim: clock set to %s" % dt)
                os.write(fd, b"\x35")
            elif cmd == CMD_READ_TIME:
                os.write(fd, b"\x35")
                body = encode_time(datetime.now() + self.clock_offset)
                self._send_packet(fd, body.ljust(32, b"\0"))
            elif cmd == CMD_KEEP_ALIVE:
                os.write(fd, b"\x35")
            elif cmd == CMD_EXIT:
                os.write(fd, b"\x35")
                self.exited = True
                self.log("sim: exit")
                return
            else:
                os.write(fd, b"\x36")

    def _send_packet(self, fd, plain: bytes) -> bool:
        os.write(fd, self.cipher.encrypt(plain))
        ack = self._read_exact(fd, 1, timeout=10.0)
        if ack != b"\x31":
            self.log("sim: missing host ack (%r)" % ack)
            return False
        return True

    def _send_read(self, fd, addr, length) -> bool:
        data = bytes(self.memory[addr:addr + length]).ljust(length, b"\0")
        npackets = (length + 4 + PACKET_SIZE - 1) // PACKET_SIZE
        stream = struct.pack("<I", addr) + data
        stream = stream.ljust(npackets * PACKET_SIZE, b"\0")
        for i in range(npackets):
            if not self._send_packet(fd, stream[i * 32:(i + 1) * 32]):
                return False
        return True


def start_pty_simulator(model="atlas2", jumps=None, log=None, **kw):
    """Create a pty, serve a simulated device on it in a thread. Returns (slave_path, device, stop_event, thread)."""
    master, slave = os.openpty()
    path = os.ttyname(slave)
    try:
        import termios
        attrs = termios.tcgetattr(master)
        attrs[0] = 0
        attrs[1] = 0
        attrs[3] = 0
        termios.tcsetattr(master, termios.TCSANOW, attrs)
    except Exception:
        pass
    dev = SimulatedDevice(model=model, jumps=jumps, log=log, **kw)
    stop = threading.Event()

    def run():
        try:
            dev.serve_fd(master, stop)
        finally:
            os.close(master)
    th = threading.Thread(target=run, daemon=True)
    th.start()
    dev._slave_fd = slave          # keep the slave open so the master does not see EOF
    return path, dev, stop, th
