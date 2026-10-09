"""Wire protocol for Alti-2 Neptune II/III, Atlas, Atlas 2 and MA-12 devices.

Based on the Alti-2 "Atlas 2 Device Communication" document and observed device
behaviour:

* 57600 baud, 8N1, CTS/RTS flow control, DTR raised.
* After a short wake-up string the device answers with the unencrypted Info
  message, sent as ASCII hex.
* Every other packet is exactly 32 bytes and XTEA encrypted:
  ``[len][payload...][pad][checksum]`` where ``checksum = sum(payload) & 0xFF``.
* The device acknowledges each host packet with 0x31 (received) followed by a
  command result code (0x35 = executed).  Every 32-byte packet the device sends
  must be acknowledged by the host with 0x31.
"""

import struct
import time
from datetime import datetime

from .xtea import XTEA

# command bytes
CMD_READ_EEPROM = 0xA0
CMD_READ_INFO_MEM = 0xA1
CMD_READ_TIME = 0xA2
CMD_KEEP_ALIVE = 0xA4
CMD_INFO_ENCRYPTED = 0xA5
CMD_EXIT = 0xAF
CMD_WRITE_EEPROM = 0xB0
CMD_WRITE_INFO_MEM = 0xB1
CMD_SET_TIME = 0xB2
CMD_ERASE_INFO_MEM = 0xB3
CMD_BOOTLOADER = 0xB4

ACK_PACKET = 0x31

PACKET_RESPONSES = {
    0x30: "abort communication",
    0x31: "encrypted packet received",
    0x32: "packet length error (decrypted length exceeds maximum; keys probably differ)",
    0x33: "checksum error (malformed packet)",
    0x34: "overflow error (flow control failure)",
}
COMMAND_RESPONSES = {
    0x35: "command executed",
    0x36: "unrecognized command",
    0x37: "invalid syntax",
    0x38: "EEPROM/FRAM write error",
    0x39: "flash erase error",
    0x41: "info memory address out of bounds",
    0x42: "flash write error",
}

PACKET_SIZE = 32
MAX_PAYLOAD = 30


class ProtocolError(IOError):
    pass


class DeviceNack(ProtocolError):
    """The device answered with something other than the expected acknowledgement."""

    def __init__(self, code, stage):
        self.code = code
        self.stage = stage
        table = PACKET_RESPONSES if stage == "packet" else COMMAND_RESPONSES
        desc = table.get(code, "unknown response")
        ProtocolError.__init__(self, "%s: device answered 0x%02X (%s)" % (stage, code, desc))


class KeyRejected(DeviceNack):
    pass


class InfoMessage:
    """The unencrypted "type zero" message. ``raw`` is the full 32 byte message."""

    FAMILY_NAMES = {0: "Neptune I", 1: "unsupported", 2: "Neptune II", 3: "Neptune III", 4: "Atlas", 5: "Atlas 2"}

    def __init__(self, raw: bytes):
        if len(raw) < 31:
            raise ProtocolError("Info message too short: %d bytes" % len(raw))
        self.raw = bytes(raw[:32])
        r = self.raw
        self.length = r[0]
        self.record_type = r[1]
        self.family = r[2]                 # selects the device model (with the product id)
        self.sw_rev = r[3] >> 4
        self.sw_major = r[3] & 0x0F
        self.sw_minor = r[4]
        self.serial = "".join(chr(b) if b != 0xFF else " " for b in r[5:14]).strip()
        self.hardware_id = r[14]
        self.product_id = r[15]
        self.fram_config = r[16]
        self.detailed_log_addr = struct.unpack_from("<I", r, 17)[0]
        self.total_jumps = struct.unpack_from("<H", r, 21)[0]
        self.total_jump_seconds = struct.unpack_from("<I", r, 23)[0]
        self.summary_log_addr = struct.unpack_from("<I", r, 27)[0]
        self.checksum = r[31] if len(r) > 31 else None

    @property
    def version(self):
        return "%d.%d.%d" % (self.sw_rev, self.sw_major, self.sw_minor)

    @property
    def model(self):
        """Model name from the family byte and product id."""
        f, p = self.family, self.product_id
        if f == 3:
            return "Neptune IIIA" if p == 6 else "Neptune III"
        if f == 4:
            return "Atlas" if p == 7 else "MA-12"
        if f == 5:
            return {5: "Neptune III", 7: "Atlas", 12: "Atlas 2", 8: "MA-12", 9: "MA-12"}.get(p, "Atlas 2 family (product %d)" % p)
        return self.FAMILY_NAMES.get(f, "unknown family %d" % f)

    @property
    def encrypted(self):
        return self.family != 0

    def verify_checksum(self):
        return (sum(self.raw[1:31]) & 0xFF) == self.raw[31]

    def __repr__(self):
        return ("InfoMessage(model=%r, serial=%r, version=%s, hw=%d, product=%d, jumps=%d, "
                "jump_seconds=%d, summary@0x%X, detailed@0x%X)" % (
                    self.model, self.serial, self.version, self.hardware_id, self.product_id,
                    self.total_jumps, self.total_jump_seconds, self.summary_log_addr, self.detailed_log_addr))


def encode_time(dt: datetime) -> bytes:
    """Device date/time structure used by B2 (set) and A2 (read)."""
    return bytes([dt.year % 256, dt.year // 256, dt.month, dt.day, 0, dt.hour, dt.minute, dt.second])


def decode_time(data: bytes) -> datetime:
    year = data[0] | (data[1] << 8)
    return datetime(year, data[2], data[3], data[5], data[6], data[7])


class Alti2Protocol:
    """Packet level communication over an already opened serial port."""

    WAKE_UP = b"      "          # six bytes; the device does not care what they are
    BYTE_TIMEOUT = 5.0
    INTER_BYTE_DELAY = 0.0015    # the device expects a short pause before every byte

    def __init__(self, port, log=None, inter_byte_delay=None):
        self.port = port
        self.cipher = None
        self.log = log or (lambda msg: None)
        self.inter_byte_delay = self.INTER_BYTE_DELAY if inter_byte_delay is None else inter_byte_delay
        self.last_response = b""

    def write(self, data: bytes):
        self.port.write(data, self.inter_byte_delay)

    def read_available(self, wait: float) -> bytes:
        """Collect whatever the device sends during `wait` seconds (diagnostics)."""
        out = bytearray()
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            chunk = self.port.read(64, min(0.2, max(0.0, deadline - time.monotonic())))
            if chunk:
                out += chunk
        return bytes(out)

    # -- low level ---------------------------------------------------------
    def set_key(self, key: bytes):
        self.cipher = XTEA(key)

    def drain(self, settle=0.1):
        time.sleep(settle)
        while self.port.in_waiting():
            self.port.read(256, 0.01)

    def read_byte(self, timeout=None, hex_mode=False) -> int:
        """Read one byte. In hex_mode, bytes below '0' (CR, LF, space) are skipped."""
        timeout = self.BYTE_TIMEOUT if timeout is None else timeout
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProtocolError("timeout waiting for data from device")
            b = self.port.read(1, remaining)
            if not b:
                continue
            if hex_mode and b[0] < 0x30:
                continue
            return b[0]

    def read_hex_byte(self) -> int:
        hi = self.read_byte(hex_mode=True)
        lo = self.read_byte(hex_mode=True)
        try:
            return int(chr(hi) + chr(lo), 16)
        except ValueError:
            raise ProtocolError("expected hex digits, got %r" % bytes([hi, lo]))

    def read_exact(self, n: int) -> bytes:
        out = bytearray()
        while len(out) < n:
            chunk = self.port.read(n - len(out), self.BYTE_TIMEOUT)
            if not chunk:
                raise ProtocolError("timeout: got %d of %d bytes" % (len(out), n))
            out += chunk
        return bytes(out)

    # -- info message -------------------------------------------------------
    def wake_and_read_info(self, settle=2.5) -> InfoMessage:
        """Send the wake-up bytes and read the ASCII-hex Info message."""
        self.write(self.WAKE_UP)
        time.sleep(settle)
        return self.read_info()

    def read_info(self) -> InfoMessage:
        length = self.read_hex_byte()
        if length < 8 or length > 64:
            raise ProtocolError("implausible Info message length 0x%02X" % length)
        body = bytearray([length])
        total = 0
        for _ in range(length):          # record type + (length - 1) data bytes
            b = self.read_hex_byte()
            body.append(b)
            total += b
        checksum = self.read_hex_byte()
        body.append(checksum)
        if (total & 0xFF) != checksum:
            raise ProtocolError("Info message checksum mismatch: computed 0x%02X, received 0x%02X"
                                % (total & 0xFF, checksum))
        self.drain()
        info = InfoMessage(bytes(body))
        self.log("info: %r" % (info,))
        return info

    # -- packets ------------------------------------------------------------
    def _expect(self, stage, good, key_stage=False):
        code = self.read_byte()
        self.last_response += bytes([code])
        if code != good:
            extra = self.read_available(0.3)
            self.last_response += extra
            self.log("%s stage: device answered 0x%02X%s" % (
                stage, code, (" followed by " + extra.hex(" ")) if extra else ""))
            if key_stage and code in (0x32, 0x33):
                raise KeyRejected(code, stage)
            raise DeviceNack(code, stage)

    def send_packet(self, payload: bytes, key_stage=False):
        """Frame, encrypt and send a command; wait for 0x31 and 0x35."""
        if self.cipher is None:
            raise ProtocolError("encryption key not set")
        if len(payload) > MAX_PAYLOAD:
            raise ValueError("payload too long: %d" % len(payload))
        buf = bytearray(PACKET_SIZE)
        buf[0] = len(payload)
        buf[1:1 + len(payload)] = payload
        buf[1 + len(payload)] = sum(payload) & 0xFF
        self.last_response = b""
        self.write(self.cipher.encrypt(bytes(buf)))
        self._expect("packet", ACK_PACKET, key_stage)
        self._expect("command", 0x35)

    def read_packet(self) -> bytes:
        """Read one encrypted 32 byte packet from the device, acknowledge and decrypt it."""
        data = self.read_exact(PACKET_SIZE)
        time.sleep(0.001)
        self.write(bytes([ACK_PACKET]))
        return self.cipher.decrypt(data)

    # -- commands -----------------------------------------------------------
    def read_memory(self, address: int, length: int, command=CMD_READ_EEPROM, progress=None,
                    key_stage=False) -> bytes:
        """A0/A1 read.  Returns exactly `length` bytes.

        The device answers with 32 byte packets: the first one carries the
        echoed 4 byte address followed by 28 data bytes, the following ones
        carry 32 data bytes each.
        """
        if length < 2 or length > 0xFFFF:
            raise ValueError("length must be 2..65535")
        npackets = (length + 4 + PACKET_SIZE - 1) // PACKET_SIZE
        self.send_packet(struct.pack("<BIH", command, address, length), key_stage=key_stage)
        out = bytearray(PACKET_SIZE * npackets)
        first = self.read_packet()
        echoed = struct.unpack_from("<I", first, 0)[0]
        if echoed != address:
            raise ProtocolError("device echoed address 0x%X, expected 0x%X" % (echoed, address))
        out[0:28] = first[4:32]
        if progress:
            progress(1, npackets)
        for i in range(1, npackets):
            out[i * 32 - 4:i * 32 + 28] = self.read_packet()
            if progress:
                progress(i + 1, npackets)
        return bytes(out[:length])

    def read_eeprom_chunked(self, address: int, length: int, chunk=0x7F00, progress=None) -> bytes:
        """Read an arbitrary amount of EEPROM in several A0 commands."""
        out = bytearray()
        done = 0
        while done < length:
            n = min(chunk, length - done)
            if n < 2:                       # minimum read is 2 bytes
                n = 2
            part = self.read_memory(address + done, n)
            out += part[:length - done]
            done += n
            if progress:
                progress(min(done, length), length)
        return bytes(out)

    def set_time(self, dt: datetime):
        self.send_packet(bytes([CMD_SET_TIME]) + encode_time(dt))

    def read_time(self) -> datetime:
        """A2 read. Best effort: not used by the download, so the response layout is taken from the docs."""
        self.send_packet(bytes([CMD_READ_TIME]))
        pkt = self.read_packet()
        if pkt[1] == CMD_READ_TIME:         # tolerate a [len][cmd] header
            pkt = pkt[2:]
        return decode_time(pkt)

    def keep_alive(self):
        self.send_packet(bytes([CMD_KEEP_ALIVE]))

    def exit(self):
        try:
            self.send_packet(bytes([CMD_EXIT]))
        except ProtocolError:
            pass
