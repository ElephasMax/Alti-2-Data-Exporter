"""Minimal serial port abstraction.

Uses pyserial when it is installed (required on Windows); otherwise falls back
to a small POSIX termios implementation so that the tool has no third-party
dependencies on Linux and macOS.
"""

import glob
import os
import select
import struct
import time

try:  # optional dependency
    import serial as _pyserial  # type: ignore
    from serial.tools import list_ports as _list_ports  # type: ignore
except Exception:  # pragma: no cover - depends on environment
    _pyserial = None
    _list_ports = None


class SerialError(IOError):
    pass


class SerialTimeout(SerialError):
    pass


def discover_ports():
    """Return a list of candidate serial device paths/names, most likely first."""
    found = []
    if _list_ports is not None:
        for p in _list_ports.comports():
            found.append(p.device)
    by_id = "/dev/serial/by-id"
    if os.path.isdir(by_id):
        for name in sorted(os.listdir(by_id)):
            real = os.path.realpath(os.path.join(by_id, name))
            if real not in found:
                found.append(real)
    for pattern in ("/dev/ttyUSB*", "/dev/ttyACM*", "/dev/cu.usbserial*", "/dev/cu.usbmodem*",
                    "/dev/tty.usbserial*", "/dev/tty.usbmodem*", "/dev/ircomm*"):
        for path in sorted(glob.glob(pattern)):
            if path not in found:
                found.append(path)
    env = os.environ.get("ALTI2_PORT")
    if env and env not in found:
        found.insert(0, env)
    return found


class _PosixSerial:
    """termios based serial port: 8N1, optional CTS/RTS flow control."""

    _BAUD = {57600: "B57600", 115200: "B115200", 9600: "B9600", 19200: "B19200", 38400: "B38400"}

    def __init__(self, path, baudrate=57600, rtscts=True):
        import termios
        import fcntl
        self._termios = termios
        self._fcntl = fcntl
        self.path = path
        self.fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            attrs = termios.tcgetattr(self.fd)
            iflag, oflag, cflag, lflag, ispeed, ospeed, cc = attrs
            iflag &= ~(termios.IGNBRK | termios.BRKINT | termios.PARMRK | termios.ISTRIP | termios.INLCR
                       | termios.IGNCR | termios.ICRNL | termios.IXON | termios.IXOFF)
            iflag &= ~getattr(termios, "IXANY", 0)
            oflag &= ~termios.OPOST
            lflag &= ~(termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG | termios.IEXTEN)
            cflag &= ~(termios.CSIZE | termios.PARENB | termios.CSTOPB)
            cflag |= termios.CS8 | termios.CREAD | termios.CLOCAL
            crtscts = getattr(termios, "CRTSCTS", 0)
            if rtscts and crtscts:
                cflag |= crtscts
            elif crtscts:
                cflag &= ~crtscts
            speed = getattr(termios, self._BAUD.get(baudrate, "B57600"))
            cc = list(cc)
            cc[termios.VMIN] = 0
            cc[termios.VTIME] = 0
            termios.tcsetattr(self.fd, termios.TCSANOW, [iflag, oflag, cflag, lflag, speed, speed, cc])
            flags = fcntl.fcntl(self.fd, fcntl.F_GETFL)
            fcntl.fcntl(self.fd, fcntl.F_SETFL, flags & ~os.O_NONBLOCK)
        except Exception:
            os.close(self.fd)
            raise

    def _modem(self, bit, on):
        termios = self._termios
        req = getattr(termios, "TIOCMBIS" if on else "TIOCMBIC", None)
        if req is None:
            return
        try:
            self._fcntl.ioctl(self.fd, req, struct.pack("I", bit))
        except OSError:
            pass  # pseudo terminals and some adapters have no modem lines

    def set_dtr(self, on: bool):
        self._modem(getattr(self._termios, "TIOCM_DTR", 0x002), on)

    def set_rts(self, on: bool):
        self._modem(getattr(self._termios, "TIOCM_RTS", 0x004), on)

    def cts(self):
        """Return the CTS modem line state, or None if the port has no modem lines."""
        termios = self._termios
        req = getattr(termios, "TIOCMGET", None)
        if req is None:
            return None
        try:
            buf = self._fcntl.ioctl(self.fd, req, b"\0\0\0\0")
            return bool(struct.unpack("I", buf)[0] & getattr(termios, "TIOCM_CTS", 0x020))
        except OSError:
            return None

    def _write_all(self, data):
        view = memoryview(data)
        while view:
            _, w, _ = select.select([], [self.fd], [], 5.0)
            if not w:
                raise SerialTimeout("write timeout on %s" % self.path)
            n = os.write(self.fd, view)
            view = view[n:]

    def write(self, data: bytes, inter_byte_delay: float = 0.0):
        """Write data; with inter_byte_delay > 0 each byte is sent separately, pacing as the device
        expects and waiting for CTS when the adapter reports it."""
        if inter_byte_delay <= 0:
            self._write_all(data)
            return
        for i in range(len(data)):
            deadline = time.monotonic() + 2.0
            while self.cts() is False and time.monotonic() < deadline:
                time.sleep(0.001)
            self._write_all(data[i:i + 1])
            try:
                self._termios.tcdrain(self.fd)
            except Exception:
                pass
            time.sleep(inter_byte_delay)

    def read(self, n: int, timeout: float) -> bytes:
        """Read up to n bytes, waiting at most `timeout` seconds for the first byte."""
        deadline = time.monotonic() + timeout
        out = bytearray()
        while len(out) < n:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            r, _, _ = select.select([self.fd], [], [], remaining)
            if not r:
                break
            chunk = os.read(self.fd, n - len(out))
            if not chunk:
                break
            out += chunk
            if out:
                deadline = time.monotonic() + timeout
        return bytes(out)

    def in_waiting(self) -> int:
        try:
            buf = self._fcntl.ioctl(self.fd, self._termios.FIONREAD, b"\0\0\0\0")
            return struct.unpack("i", buf)[0]
        except OSError:
            r, _, _ = select.select([self.fd], [], [], 0)
            return 1 if r else 0

    def flush_input(self):
        try:
            self._termios.tcflush(self.fd, self._termios.TCIFLUSH)
        except Exception:
            pass

    def close(self):
        if self.fd is not None:
            try:
                os.close(self.fd)
            finally:
                self.fd = None


class _PySerial:
    def __init__(self, path, baudrate=57600, rtscts=True):
        self.path = path
        self._s = _pyserial.Serial(path, baudrate=baudrate, bytesize=8, parity="N", stopbits=1,
                                   rtscts=rtscts, dsrdtr=False, timeout=0, write_timeout=5)

    def set_dtr(self, on):
        self._s.dtr = on

    def set_rts(self, on):
        self._s.rts = on

    def cts(self):
        try:
            return bool(self._s.cts)
        except Exception:
            return None

    def write(self, data, inter_byte_delay=0.0):
        if inter_byte_delay <= 0:
            self._s.write(data)
            self._s.flush()
            return
        for i in range(len(data)):
            deadline = time.monotonic() + 2.0
            while self.cts() is False and time.monotonic() < deadline:
                time.sleep(0.001)
            self._s.write(data[i:i + 1])
            self._s.flush()
            time.sleep(inter_byte_delay)

    def read(self, n, timeout):
        self._s.timeout = timeout
        out = bytearray()
        while len(out) < n:
            chunk = self._s.read(n - len(out))
            if not chunk:
                break
            out += chunk
        return bytes(out)

    def in_waiting(self):
        return self._s.in_waiting

    def flush_input(self):
        self._s.reset_input_buffer()

    def close(self):
        self._s.close()


def open_port(path, baudrate=57600, rtscts=True, backend=None):
    """Open a serial port. backend: None (auto), 'pyserial' or 'posix'."""
    if backend == "posix" or (backend is None and _pyserial is None):
        if os.name != "posix":
            raise SerialError("pyserial is required on this platform (pip install pyserial)")
        return _PosixSerial(path, baudrate, rtscts)
    if _pyserial is None:
        raise SerialError("pyserial is not installed")
    return _PySerial(path, baudrate, rtscts)
