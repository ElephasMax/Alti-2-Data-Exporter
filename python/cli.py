"""Command line interface: python -m python <command> ..."""

import argparse
import json
import os
import sys
import time
from datetime import datetime

from . import __version__
from . import keys as _keys
from .device import Alti2Device, find_device
from .logbook import Logbook, jump_to_dict
from .protocol import ProtocolError, Alti2Protocol
from .records import JUMP_COUNT_ADDRESS
from .serialport import discover_ports, SerialError
from .units import UNITS, UNIT_FIELDS, convert_jump, hms, to_units, unit_label


def _log_factory(verbose):
    def log(msg):
        if verbose:
            sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
    return log


def _progress(stage, a, b):
    if stage == "summary":
        sys.stderr.write("\r  summary log: %d/%d bytes" % (a, b))
    elif stage == "jumps":
        sys.stderr.write("\r  jumps: %d/%d        " % (a, b))
    if a == b:
        sys.stderr.write("\n")
    sys.stderr.flush()


def _resolve_port(args):
    if args.port:
        return args.port
    ports = discover_ports()
    if not ports:
        raise SystemExit("no serial ports found (use --port, or set ALTI2_PORT)")
    if len(ports) == 1:
        return ports[0]
    sys.stderr.write("probing %d ports...\n" % len(ports))
    found = find_device(ports, log=_log_factory(args.verbose), fast=args.fast)
    if not found:
        raise SystemExit("no Alti-2 device answered on: %s" % ", ".join(ports))
    return found


def _open(args):
    return Alti2Device(_resolve_port(args), log=_log_factory(args.verbose), fast=args.fast, backend=args.backend,
                       inter_byte_delay=args.byte_delay)


def _candidates(args, info):
    if getattr(args, "key", None):
        return _keys.candidates_with_override(info.raw, args.key)
    return None


def _establish(args, dev):
    return dev.establish_key(_candidates(args, dev.info))


def cmd_ports(args):
    ports = discover_ports()
    if not ports:
        print("no serial ports found")
    for p in ports:
        print(p)


def cmd_info(args):
    with _open(args) as dev:
        info = dev.info
        print("Model:            %s" % info.model)
        print("Serial number:    %s" % info.serial)
        print("Firmware:         %s" % info.version)
        print("Hardware id:      %d   product id: %d   family byte: %d" % (info.hardware_id, info.product_id, info.family))
        print("Total jumps:      %d" % info.total_jumps)
        print("Total jump time:  %d s (%d:%02d:%02d)" % (info.total_jump_seconds, info.total_jump_seconds // 3600,
                                                          info.total_jump_seconds // 60 % 60, info.total_jump_seconds % 60))
        print("Summary log at:   0x%X   detailed log at: 0x%X   FRAM config: %d" % (
            info.summary_log_addr, info.detailed_log_addr, info.fram_config))
        print("Info message:     %s" % " ".join("%02X" % b for b in info.raw))
        if args.verify_key:
            label = _establish(args, dev)
            print("Encryption key:   %s (%s)" % (dev.key.hex(), label))
            print("Records in log:   %d" % dev.jump_count())


def cmd_download(args):
    lb = Logbook.load(args.logbook)
    with _open(args) as dev:
        print("Connected: %s serial %s, firmware %s, %d jumps on device" % (
            dev.info.model, dev.info.serial, dev.info.version, dev.info.total_jumps))
        _establish(args, dev)
        res = dev.download(with_profiles=not args.no_profiles, include_deleted=args.include_deleted,
                           progress=_progress if not args.quiet else None)
        if args.set_clock:
            dev.set_clock(datetime.now())
            print("Device clock set to %s" % datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    for w in res.warnings:
        print("warning: %s" % w)
    print("Key used: %s" % res.key_label)
    print("Tables: jump types=%s aircraft=%s dropzones=%s" % (
        res.tables.get("jump_types"), res.tables.get("aircraft"), res.tables.get("dropzones")))
    print("Downloaded %d jumps (%d skipped)" % (len(res.jumps), len(res.skipped)))
    jumps = [jump_to_dict(j) for j in res.jumps]
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(jumps, f, indent=1)
        print("Wrote %s" % args.json)
    if not args.no_save:
        r = lb.add(jumps)          # stores these same dicts, so the totals below cover the whole logbook
        lb.save()
        print("Logbook %s: %d added, %d updated, %d total" % (lb.path, r["added"], r["updated"], len(lb.jumps)))
    totals = Logbook.freefall_totals(lb.jumps if not args.no_save else jumps)
    shown = sorted(jumps, key=lambda j: j.get("jump_no") or 0, reverse=True)[:args.show] if args.show else []
    _print_table(shown, args.units, LIST_DEFAULT, totals)


def cmd_set_clock(args):
    when = datetime.fromisoformat(args.time) if args.time else None
    with _open(args) as dev:
        _establish(args, dev)
        dev.set_clock(when)
        print("Clock set to %s on %s %s" % ((when or datetime.now()).strftime("%Y-%m-%d %H:%M:%S"),
                                            dev.info.model, dev.info.serial))


def cmd_read(args):
    addr = int(args.address, 0)
    with _open(args) as dev:
        _establish(args, dev)
        data = dev.proto.read_eeprom_chunked(addr, args.length)
    if args.out:
        with open(args.out, "wb") as f:
            f.write(data)
        print("wrote %d bytes to %s" % (len(data), args.out))
    else:
        for off in range(0, len(data), 16):
            chunk = data[off:off + 16]
            print("%08X  %-48s %s" % (addr + off, " ".join("%02X" % b for b in chunk),
                                      "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)))


# Columns for `list`: name -> (field, heading, numeric).  Same set and defaults as the web version.
LIST_COLUMNS = {
    "jump": ("jump_no", "Jump #", True), "date": ("date", "Date", False),
    "exit": ("exit_alt_ft", "Exit", True), "deploy": ("deploy_alt_ft", "Deploy", True),
    "freefall": ("freefall_time_s", "Freefall (s)", True), "total_freefall": ("total_freefall_s", "Total freefall", True),
    "canopy": ("canopy_time_s", "Canopy (s)", True), "ground": ("ground_alt_ft", "Ground alt", True),
    "type": ("jump_type", "Type", False), "aircraft": ("aircraft", "Aircraft", False), "dropzone": ("dropzone", "Dropzone", False),
    "tas_3k": ("tas_3k", "Speed @ 3k ft", True), "tas_6k": ("tas_6k", "Speed @ 6k ft", True),
    "tas_9k": ("tas_9k", "Speed @ 9k ft", True), "tas_12k": ("tas_12k", "Speed @ 12k ft", True),
    "chart": ("profile", "Chart", False), "notes": ("notes", "Notes", False), "device": ("device_model", "Device", False),
    "serial": ("device_serial", "Serial #", False), "firmware": ("fw_version", "Firmware", False),
    "deleted": ("deleted", "Deleted", False), "imported": ("imported", "Imported", False),
}
LIST_FIXED = ["jump", "date"]
LIST_DEFAULT = ["exit", "deploy", "freefall", "total_freefall"]


def _column_names(text):
    """Parse --columns: comma separated column names (or field names), or "all"."""
    if text.strip() == "all":
        return [c for c in LIST_COLUMNS if c not in LIST_FIXED]
    by_field = {field: name for name, (field, _, _) in LIST_COLUMNS.items()}
    names = []
    for part in filter(None, (p.strip() for p in text.split(","))):
        name = part if part in LIST_COLUMNS else by_field.get(part)
        if not name:
            raise SystemExit("unknown column %r; choose from: %s" % (part, ", ".join(LIST_COLUMNS)))
        if name not in LIST_FIXED and name not in names:
            names.append(name)
    return names


def _raw_value(j, field, totals):
    if field == "total_freefall_s":
        return totals.get(id(j))
    if field == "profile":
        return 1 if j.get("profile") else 0
    if field == "deleted":
        return 1 if j.get("deleted") else 0
    return j.get(field)


def _cell(j, field, units, totals):
    v = _raw_value(j, field, totals)
    if field == "total_freefall_s":
        return hms(v) if v is not None else ""
    if field == "profile":
        return "yes" if v else "no"
    if field == "deleted":
        return "yes" if v else ""
    if field in ("date", "imported"):
        return (v or "").replace("T", " ")[:16 if field == "date" else 19]
    if field.startswith("tas_") and not v:
        return "-"                      # 0 = the jump never passed that altitude
    if field in UNIT_FIELDS:
        v = to_units(v, UNIT_FIELDS[field], units)
    return "" if v is None else str(v)


def _print_table(jumps, units="imperial", columns=None, totals=None):
    if not jumps:
        return
    totals = totals or {}
    cols = [LIST_COLUMNS[c] for c in LIST_FIXED + list(columns if columns is not None else LIST_DEFAULT)]
    heads = ["%s (%s)" % (h, unit_label(UNIT_FIELDS[f], units)) if f in UNIT_FIELDS else h for f, h, _ in cols]
    rows = [[_cell(j, f, units, totals) for f, _, _ in cols] for j in jumps]
    widths = [max([len(h)] + [len(r[i]) for r in rows]) for i, h in enumerate(heads)]
    line = lambda cells: "  ".join(c.rjust(w) if cols[i][2] else c.ljust(w) for i, (c, w) in enumerate(zip(cells, widths))).rstrip()
    print(line(heads))
    for r in rows:
        print(line(r))


def _sort_jumps(jumps, column, reverse, totals):
    """Sort like the web table: numbers and dates biggest/newest first, text A-Z; empty values last,
    ties by jump number.  `reverse` flips the order (empty values stay last)."""
    field, _, numeric = LIST_COLUMNS[column]
    descending = numeric or field in ("date", "imported")
    if reverse:
        descending = not descending
    filled = [j for j in jumps if _raw_value(j, field, totals) not in (None, "")]
    empty = [j for j in jumps if _raw_value(j, field, totals) in (None, "")]

    def key(j):
        v = _raw_value(j, field, totals)
        return (v if isinstance(v, (int, float)) else str(v).lower(), j.get("jump_no") or 0)
    return sorted(filled, key=key, reverse=descending) + sorted(empty, key=lambda j: j.get("jump_no") or 0, reverse=descending)


def cmd_list(args):
    lb = Logbook.load(args.logbook)
    if args.sort not in LIST_COLUMNS:
        raise SystemExit("unknown sort column %r; choose from: %s" % (args.sort, ", ".join(LIST_COLUMNS)))
    totals = Logbook.freefall_totals(lb.jumps)
    jumps = lb.jumps[-args.last:] if args.last else lb.jumps
    columns = _column_names(args.columns) if args.columns else LIST_DEFAULT
    _print_table(_sort_jumps(jumps, args.sort, args.reverse, totals), args.units, columns, totals)
    print("%d jumps in %s" % (len(lb.jumps), lb.path))


def cmd_show(args):
    lb = Logbook.load(args.logbook)
    j = lb.find(args.jump_no, args.serial)
    if not j:
        raise SystemExit("jump %d not found" % args.jump_no)
    prof = j.get("profile")
    out = convert_jump(j, args.units)
    total = Logbook.freefall_totals(lb.jumps).get(id(j))
    out["total_freefall_s"] = total
    out["total_freefall"] = hms(total) if total is not None else None
    if prof and not args.profile:
        out["profile"] = "%d points (use --profile to print)" % len(prof["points"])
    print(json.dumps(out, indent=1))


def cmd_export(args):
    lb = Logbook.load(args.logbook)
    if args.jump_no is not None:
        j = lb.find(args.jump_no)
        if not j:
            raise SystemExit("jump %d not found" % args.jump_no)
        Logbook.export_profile_csv(j, args.out, args.units)
    else:
        lb.export_csv(args.out, args.units)
    print("wrote %s" % args.out)


def cmd_stats(args):
    lb = Logbook.load(args.logbook)
    for k, v in lb.stats(args.units).items():
        print("%-18s %s" % (k + ":", v))


def cmd_probe(args):
    """Send the first read command with each candidate key and show the raw bytes the device returns."""
    import struct
    from .protocol import CMD_READ_EEPROM
    dev = _open(args)
    dev.connect()
    info = dev.info
    print("Device: %s serial %s firmware %s; info: %s" % (info.model, info.serial, info.version, info.raw.hex(" ")))
    cands = _candidates(args, info) or _keys.key_candidates(info.raw)
    if args.first:
        cands = cands[:args.first]
    try:
        for label, key in cands:
            dev.proto.set_key(key)
            payload = struct.pack("<BIH", CMD_READ_EEPROM, JUMP_COUNT_ADDRESS, 2)
            buf = bytearray(32)
            buf[0] = len(payload)
            buf[1:1 + len(payload)] = payload
            buf[1 + len(payload)] = sum(payload) & 0xFF
            frame = dev.proto.cipher.encrypt(bytes(buf))
            dev.proto.write(frame)
            got = dev.proto.read_available(args.wait)
            print("%-22s key=%s" % (label, key.hex()))
            print("    sent     : %s" % frame.hex(" "))
            print("    received : %s   %r" % (got.hex(" ") if got else "(nothing)", got))
            if got[:2] == b"\x31\x35":
                print("    -> accepted. Reading the rest of the reply...")
                rest = dev.proto.read_available(1.0)
                print("    data     : %s" % rest.hex(" "))
                dev.proto.write(b"\x31")
                dev.key, dev.key_label = key, label      # so close() sends the exit command
                break
            if not got or got[:1] == b"\x30":
                print("    -> no answer/abort: reconnecting")
                try:
                    dev.reconnect()
                except ProtocolError as e:
                    print("    reconnect failed: %s" % e)
                    break
            else:
                dev.proto.drain(0.5)
    finally:
        dev.close(send_exit=dev.key is not None)


def cmd_simulate(args):
    from .simulator import start_pty_simulator, sample_jumps, MODELS
    new_epoch = MODELS[args.model][0] == 5
    jumps = sample_jumps(args.jumps, new_epoch)
    path, dev, stop, th = start_pty_simulator(args.model, jumps, log=_log_factory(args.verbose))
    print("Simulated %s with %d jumps listening on %s" % (args.model, args.jumps, path), flush=True)
    print("Try:  python -m python --fast --port %s download --logbook /tmp/sim-logbook.json" % path, flush=True)
    try:
        while th.is_alive():
            time.sleep(0.5)
    except KeyboardInterrupt:
        stop.set()


def build_parser():
    p = argparse.ArgumentParser(prog="alti2export", description="Alti-2 Atlas / Atlas 2 / Neptune jump log downloader")
    p.add_argument("--version", action="version", version="alti2export " + __version__)
    p.add_argument("-p", "--port", help="serial port (default: auto-detect, or $ALTI2_PORT)")
    p.add_argument("-v", "--verbose", action="store_true", help="log protocol activity to stderr")
    p.add_argument("--fast", action="store_true", help="skip the multi-second settle delays (simulator only)")
    p.add_argument("--backend", choices=["pyserial", "posix"], help="serial backend (default: auto)")
    p.add_argument("--byte-delay", type=float, default=None,
                   help="seconds between transmitted bytes (default 0.0015; 0 = burst)")
    p.add_argument("-k", "--key", help="try this key first: 32 hex digits, or 3 product code bytes like AA6944")
    p.add_argument("-l", "--logbook", help="logbook file (default: ~/.alti2export/logbook.json)")
    p.add_argument("-u", "--units", choices=UNITS, default=os.environ.get("ALTI2_UNITS", "imperial"),
                   help="units for altitudes and speeds: imperial = ft, mph (default); metric = m, km/h"
                        " (or set $ALTI2_UNITS)")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("ports", help="list serial ports").set_defaults(func=cmd_ports)
    s = sub.add_parser("info", help="read the device Info message")
    s.add_argument("--verify-key", action="store_true", help="also derive/verify the encryption key")
    s.set_defaults(func=cmd_info)
    s = sub.add_parser("probe", help="diagnostic: send the first command with each candidate key, print raw replies")
    s.add_argument("--wait", type=float, default=3.0, help="seconds to collect the reply")
    s.add_argument("--first", type=int, default=0, help="only try the first N candidates")
    s.set_defaults(func=cmd_probe)
    s = sub.add_parser("download", help="download the jump log into the logbook")
    s.add_argument("--no-profiles", action="store_true", help="skip the freefall altitude profiles")
    s.add_argument("--include-deleted", action="store_true", help="also import records flagged as deleted")
    s.add_argument("--set-clock", action="store_true", help="set the device clock from this computer afterwards")
    s.add_argument("--json", help="also write the downloaded jumps to this JSON file")
    s.add_argument("--no-save", action="store_true", help="do not touch the logbook")
    s.add_argument("--show", type=int, default=20, help="print the last N downloaded jumps")
    s.add_argument("-q", "--quiet", action="store_true")
    s.set_defaults(func=cmd_download)
    s = sub.add_parser("set-clock", help="set the device date/time")
    s.add_argument("--time", help="ISO date-time to set (default: now)")
    s.set_defaults(func=cmd_set_clock)
    s = sub.add_parser("read", help="dump device EEPROM")
    s.add_argument("address")
    s.add_argument("length", type=int)
    s.add_argument("--out", help="write binary to file instead of hex dump")
    s.set_defaults(func=cmd_read)
    s = sub.add_parser("list", help="list jumps in the logbook")
    s.add_argument("--last", type=int, default=0, help="only the N most recent jumps")
    s.add_argument("-c", "--columns", help="comma separated columns to show after jump and date, or 'all' "
                   "(default: %s; available: %s)" % (",".join(LIST_DEFAULT), ", ".join(c for c in LIST_COLUMNS if c not in LIST_FIXED)))
    s.add_argument("-s", "--sort", default="jump", help="column to sort by (default: jump, highest first)")
    s.add_argument("-r", "--reverse", action="store_true", help="reverse the sort order")
    s.set_defaults(func=cmd_list)
    s = sub.add_parser("show", help="show one jump as JSON")
    s.add_argument("jump_no", type=int)
    s.add_argument("--serial")
    s.add_argument("--profile", action="store_true", help="include all profile points")
    s.set_defaults(func=cmd_show)
    s = sub.add_parser("export", help="export logbook (CSV) or one jump's profile (CSV)")
    s.add_argument("out")
    s.add_argument("--jump-no", type=int, help="export this jump's altitude profile instead of the logbook")
    s.set_defaults(func=cmd_export)
    sub.add_parser("stats", help="logbook totals").set_defaults(func=cmd_stats)
    s = sub.add_parser("simulate", help="run a simulated device on a pseudo terminal")
    s.add_argument("--model", default="atlas2", choices=["atlas2", "atlas", "atlas-newfw", "neptune3", "neptune3-newfw", "neptune2", "ma12"])
    s.add_argument("--jumps", type=int, default=8)
    s.set_defaults(func=cmd_simulate)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except (ProtocolError, SerialError) as e:
        sys.stderr.write("error: %s\n" % e)
        return 2
    except KeyboardInterrupt:
        return 130
    return 0
