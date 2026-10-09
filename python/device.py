"""High level driver: connect, identify, derive the key, download the jump log."""

import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Dict, List, Optional

from . import keys as _keys
from .protocol import Alti2Protocol, InfoMessage, KeyRejected, ProtocolError, DeviceNack
from .records import (JUMP_COUNT_ADDRESS, NAME_TABLES, NAME_TABLE_SIZE, PROFILE_RECORD_SIZE,
                      SUMMARY_RECORD_SIZE, Profile, SummaryRecord, parse_name_table, parse_profile,
                      parse_summary, name_table_checksum)
from .serialport import open_port, discover_ports

MAX_SUMMARY_RECORDS = 2978


@dataclass
class Jump:
    summary: SummaryRecord
    profile: Optional[Profile] = None
    jump_type: str = ""
    aircraft: str = ""
    dropzone: str = ""
    device_serial: str = ""
    device_model: str = ""

    @property
    def jump_no(self):
        return self.summary.jump_no


@dataclass
class DownloadResult:
    info: InfoMessage
    key_label: str
    jumps: List[Jump] = field(default_factory=list)
    skipped: List[SummaryRecord] = field(default_factory=list)
    tables: Dict[str, List[str]] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)


class Alti2Device:
    """Session with one device.  Use as a context manager or call connect()/close()."""

    OPEN_SETTLE = 5.0         # wait 5 s after raising DTR before talking
    WAKE_SETTLE = 2.5

    WAKE_RETRIES = 3

    def __init__(self, port_path: str, log: Optional[Callable[[str], None]] = None,
                 backend: Optional[str] = None, fast=False, inter_byte_delay=None):
        self.port_path = port_path
        self.log = log or (lambda msg: None)
        self.backend = backend
        self.port = None
        self.proto: Optional[Alti2Protocol] = None
        self.info: Optional[InfoMessage] = None
        self.key_label: Optional[str] = None
        self.key: Optional[bytes] = None
        self.inter_byte_delay = inter_byte_delay
        self.fast = fast
        if fast:
            self.OPEN_SETTLE, self.WAKE_SETTLE = 0.2, 0.2
            if inter_byte_delay is None:
                self.inter_byte_delay = 0.0

    # -- lifecycle --------------------------------------------------------
    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *exc):
        self.close()

    def connect(self) -> InfoMessage:
        self.log("opening %s" % self.port_path)
        self.port = open_port(self.port_path, 57600, rtscts=True, backend=self.backend)
        self.proto = Alti2Protocol(self.port, self.log, inter_byte_delay=self.inter_byte_delay)
        self.port.set_dtr(True)
        time.sleep(self.OPEN_SETTLE)
        self.proto.drain()
        last = None
        for attempt in range(self.WAKE_RETRIES):
            try:
                self.info = self.proto.wake_and_read_info(self.WAKE_SETTLE)
                break
            except ProtocolError as e:
                last = e
                self.log("wake-up attempt %d failed: %s" % (attempt + 1, e))
                self.proto.drain(0.5)
                if not self.fast:
                    time.sleep(2.0 * (attempt + 1))
        else:
            raise ProtocolError("device did not send the Info message (%s)" % last)
        if not self.info.verify_checksum():
            raise ProtocolError("Info message checksum invalid")
        self.log("connected to %s serial %s firmware %s" % (self.info.model, self.info.serial, self.info.version))
        return self.info

    def reconnect(self):
        self.close(send_exit=False)
        time.sleep(0.5 if self.fast else 3.0)      # let the device notice DTR dropping
        return self.connect()

    def close(self, send_exit=True):
        if self.proto is not None and send_exit and self.key is not None:
            try:
                self.proto.exit()
            except Exception:
                pass
        if self.port is not None:
            try:
                self.port.set_dtr(False)
            except Exception:
                pass
            self.port.close()
        self.port = None
        self.proto = None
        self.key = None

    # -- key ---------------------------------------------------------------
    def establish_key(self, candidates=None) -> str:
        """Try candidate keys until the device accepts a read of the jump counter."""
        if self.info is None:
            raise ProtocolError("not connected")
        if not self.info.encrypted:
            raise ProtocolError("%s uses the unencrypted Neptune I protocol, which is not supported" % self.info.model)
        candidates = candidates or _keys.key_candidates(self.info.raw)
        attempts = []
        for label, key in candidates:
            self.proto.set_key(key)
            self.log("trying key %s (%s)" % (label, key.hex()))
            try:
                self.proto.read_memory(JUMP_COUNT_ADDRESS, 2, key_stage=True)
                self.key, self.key_label = key, label
                self.log("key accepted: %s" % label)
                return label
            except KeyRejected as e:
                attempts.append("%s: %s" % (label, e))
                self.proto.drain(0.3)
            except DeviceNack as e:
                attempts.append("%s: %s" % (label, e))
                if e.code == 0x30:          # device aborted: start over
                    self._safe_reconnect(attempts)
                else:
                    self.proto.drain(0.3)
            except ProtocolError as e:
                attempts.append("%s: %s" % (label, e))
                self._safe_reconnect(attempts)
        raise ProtocolError("no key accepted by the device:\n  " + "\n  ".join(attempts))

    def _safe_reconnect(self, attempts):
        try:
            self.reconnect()
        except ProtocolError as e:
            raise ProtocolError("device stopped responding; reconnect failed (%s). Attempts so far:\n  %s"
                                % (e, "\n  ".join(attempts)))

    # -- reads -------------------------------------------------------------
    def jump_count(self) -> int:
        data = self.proto.read_memory(JUMP_COUNT_ADDRESS, 2)
        return data[0] | (data[1] << 8)

    def read_name_tables(self) -> Dict[str, List[str]]:
        tables = {}
        for name, addr in NAME_TABLES.items():
            data = self.proto.read_memory(addr, NAME_TABLE_SIZE)
            if name_table_checksum(data) != data[0]:
                self.log("warning: checksum mismatch in %s table" % name)
            tables[name] = [e.name for e in parse_name_table(data)]
        return tables

    def read_summary_records(self, count: int, progress=None) -> List[SummaryRecord]:
        if count > MAX_SUMMARY_RECORDS:
            raise ProtocolError("device reports %d records; maximum is %d" % (count, MAX_SUMMARY_RECORDS))
        if count == 0:
            return []
        raw = self.proto.read_eeprom_chunked(self.info.summary_log_addr, count * SUMMARY_RECORD_SIZE,
                                             chunk=1489 * SUMMARY_RECORD_SIZE, progress=progress)
        new_epoch = self.info.family == 5
        return [parse_summary(raw[i * 22:(i + 1) * 22], new_epoch) for i in range(count)]

    def read_profile(self, slot: int) -> Profile:
        data = self.proto.read_memory(self.info.detailed_log_addr + slot * PROFILE_RECORD_SIZE, PROFILE_RECORD_SIZE)
        return parse_profile(data)

    def set_clock(self, dt: Optional[datetime] = None):
        self.proto.set_time(dt or datetime.now())

    # -- the whole thing ------------------------------------------------------
    def download(self, with_profiles=True, include_deleted=False, min_jump_no=0,
                 progress: Optional[Callable[[str, int, int], None]] = None) -> DownloadResult:
        """Download the complete jump log."""
        if self.key is None:
            self.establish_key()
        result = DownloadResult(info=self.info, key_label=self.key_label)

        def prog(stage, a, b):
            if progress:
                progress(stage, a, b)

        result.tables = self.read_name_tables()
        prog("tables", 1, 1)
        count = self.jump_count()
        self.log("device holds %d summary records" % count)
        records = self.read_summary_records(count, lambda a, b: prog("summary", a, b))
        profiles_ok = with_profiles
        total = len(records)
        for idx in range(total - 1, -1, -1):        # newest first
            rec = records[idx]
            prog("jumps", total - idx, total)
            skip = rec.deleted and not include_deleted
            if rec.jump_no <= min_jump_no:
                skip = True
            # skip records written by firmware 2.9.0-2.9.8 on product 5 (known bad records)
            if rec.fw_tuple[:2] == (2, 9) and rec.fw_tuple[2] < 9 and self.info.product_id == 5:
                skip = True
            if skip:
                result.skipped.append(rec)
                continue
            jump = Jump(summary=rec, device_serial=self.info.serial, device_model=self.info.model)
            tables = result.tables
            jump.jump_type = _lookup(tables.get("jump_types"), rec.jump_type_idx, rec.jump_type_custom)
            jump.aircraft = _lookup(tables.get("aircraft"), rec.aircraft_idx)
            jump.dropzone = _lookup(tables.get("dropzones"), rec.dropzone_idx)
            if profiles_ok:
                try:
                    prof = self.read_profile(rec.profile_slot)
                except ProtocolError as e:
                    result.warnings.append("jump %d: profile read failed: %s" % (rec.jump_no, e))
                    profiles_ok = False
                    prof = None
                if prof is not None:
                    if prof.jump_no != idx:
                        # the slot's jump number must match the record index; stop
                        # reading profiles once they stop matching (the ring buffer wrapped).
                        result.warnings.append("jump %d: profile slot %d belongs to record %d; no further profiles read"
                                               % (rec.jump_no, rec.profile_slot, prof.jump_no))
                        profiles_ok = False
                    else:
                        prof.jump_no = rec.jump_no
                        jump.profile = prof
            result.jumps.append(jump)
        result.jumps.reverse()      # oldest first
        return result


def _lookup(table, idx, custom=False):
    if table and 0 <= idx < len(table) and table[idx]:
        return ("<%s>" % table[idx]) if custom else table[idx]
    return "#%d" % idx


def find_device(ports=None, log=None, fast=False) -> Optional[str]:
    """Probe candidate ports and return the first one that answers with an Info message."""
    for path in ports or discover_ports():
        dev = Alti2Device(path, log=log, fast=fast)
        try:
            dev.connect()
            dev.close(send_exit=False)
            return path
        except Exception as e:
            if log:
                log("%s: %s" % (path, e))
            try:
                dev.close(send_exit=False)
            except Exception:
                pass
    return None
