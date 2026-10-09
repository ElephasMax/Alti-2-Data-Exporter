# Alti-2 Data Exporter: Python command-line version

A command-line tool that downloads the jump log from an Alti-2 altimeter over
USB, keeps a local logbook, and exports it to CSV. It reads the same
altimeters and uses the same logbook format as the
[web version](../README.md), so logbooks move freely between the two.

> **⚠ Warning.** Reading data is normally safe, but you use this software and
> the information it provides entirely at your own risk. The software is
> provided "as is", without warranty of any kind. The author is not liable for
> any damage, malfunction, injury or other issues resulting from its use.
> Always check that your altimeter works correctly before you jump.

Is your altimeter not supported? Questions, comments or concerns? Email
[staff@skydiving.is](mailto:staff@skydiving.is).

## Supported altimeters

Atlas, Atlas 2, Neptune II, Neptune III / IIIA and MA-12. The original
Neptune I is not supported.

## Requirements

* **Python 3.8 or newer.**
* **Linux or macOS:** nothing else. A built-in serial backend is used.
* **Windows:** `pip install pyserial`.
* **A USB data cable** for your altimeter.

On Linux, make sure your user may access the serial port (usually by joining
the `dialout` group).

## Running it

Run the tool from the repository folder (the one that contains `python/`):

```sh
python3 -m python <command> [options]
```

## Quick start

```sh
python3 -m python ports            # list serial ports
python3 -m python info             # check the altimeter answers: model, serial, firmware, totals
python3 -m python download         # download every jump into the logbook
python3 -m python list             # show the logbook
python3 -m python export jumps.csv # export it for a spreadsheet
```

Without `--port`, the tool tries each likely serial port until an altimeter
answers. On macOS the altimeter usually appears as
`/dev/cu.usbserial-XXXXXXXX`, and on Linux as `/dev/ttyUSB0` or
`/dev/ttyACM0`. Connecting takes about 8 seconds while the altimeter wakes up.

## Commands

### Device

| Command | What it does |
|---|---|
| `ports` | Lists the serial ports found. |
| `info` | Reads the altimeter's Info message: model, serial number, firmware, total jumps and total jump time. `--verify-key` also checks which encryption key the altimeter accepts. |
| `download` | Downloads every jump, with its altitude chart, into the logbook, then prints the newest ones. |
| `set-clock` | Sets the altimeter's clock from this computer, or to `--time 2025-06-01T10:00:00`. |
| `read ADDRESS LENGTH` | Hex dump of the altimeter's memory, or `--out file.bin` to save it. For diagnostics. |
| `probe` | Diagnostic: shows the altimeter's raw reply to each candidate encryption key. |

`download` options:

* `--no-profiles`: skip the altitude charts (faster).
* `--include-deleted`: also import jumps deleted on the altimeter.
* `--set-clock`: set the altimeter's clock afterwards.
* `--json FILE`: also save the downloaded jumps to a JSON file.
* `--no-save`: don't change the logbook.
* `--show N`: how many downloaded jumps to print (default 20).
* `-q`: no progress output.

### Logbook

| Command | What it does |
|---|---|
| `list` | Shows the logbook as a table. |
| `show JUMP` | One jump as JSON, in the selected units, with its total freefall. `--profile` includes every chart point. `--serial` picks a device if several have the same jump number. |
| `export FILE` | Exports the whole logbook as CSV. |
| `export FILE --jump-no JUMP` | Exports one jump's altitude chart as CSV (time and altitude). |
| `stats` | Totals: jumps, freefall time, highest exit, lowest deploy, first and last jump, devices. |

`list` options:

* `-c, --columns`: which columns to show after Jump # and Date, comma
  separated, or `all`. The default is `exit,deploy,freefall,total_freefall`.
  Available: `exit`, `deploy`, `freefall`, `total_freefall`, `canopy`,
  `ground`, `type`, `aircraft`, `dropzone`, `tas_3k`, `tas_6k`, `tas_9k`,
  `tas_12k`, `chart`, `notes`, `device`, `serial`, `firmware`, `deleted`,
  `imported`.
* `-s, --sort`: the column to sort by. The default is `jump`, highest first.
  Numbers and dates sort largest or newest first, and text A to Z. Empty
  values always go last.
* `-r, --reverse`: reverse the sort order.
* `--last N`: only the N most recent jumps.

Examples:

```sh
python3 -m python list -c exit,deploy,freefall,aircraft,dropzone
python3 -m python list -s exit                 # highest exits first
python3 -m python --units metric list -c all
python3 -m python export p350.csv --jump-no 350
```

### Global options

These go before the command:

| Option | What it does |
|---|---|
| `-u, --units imperial\|metric` | Units for altitudes and speeds: imperial is ft and mph (default), metric is m and km/h. Or set `$ALTI2_UNITS`. |
| `-l, --logbook FILE` | Logbook file. The default is `~/.alti2export/logbook.json`. |
| `-p, --port PORT` | Serial port to use. Or set `$ALTI2_PORT`. |
| `-v, --verbose` | Print the protocol conversation. |
| `--byte-delay SECONDS` | Pause between transmitted bytes (default 0.0015; 0 sends in bursts). |
| `-k, --key KEY` | Try this encryption key first: 32 hex digits, or 3 product code bytes such as `AA6944`. |
| `--backend pyserial\|posix` | Serial backend (default: automatic). |

## The logbook

The logbook is a JSON file, `~/.alti2export/logbook.json` by default. It's the
same format as the web version's **Export JSON**:

* **Python to web:** load the file with **Import JSON…** on the web page.
* **Web to Python:** pass the web page's exported `logbook.json` with `-l`.

Downloading again updates jumps that are already in the logbook, and keeps
their notes.

**Total freefall** is a running total of freefall time: each jump's own
freefall time plus that of every jump with a lower jump number. Deleted jumps
don't count.

## CSV export

`export FILE` writes every data point for every jump, in the selected units:

* the standard columns: jump number, date, device, jump type, aircraft,
  dropzone, exit, deploy, freefall and canopy time, ground altitude, the four
  speeds, firmware, deleted, number of chart points and notes;
* any other fields stored for the jumps;
* `freefall_start_s`, `avg_speed` (worked out as (exit − deploy) ÷ freefall
  time) and `total_freefall_s`.

Column names say which unit they use, for example `exit_alt_ft` or
`exit_alt_m`, and `tas_3k_mph` or `tas_3k_kmh`. The columns and values are
exactly the same as the web version's **Export CSV**.

## Units

The altimeter stores altitudes in **meters** and the four speed values in
**meters per second**. Both were checked against an Atlas 2's own display. The
stored field names (`exit_alt_ft`, `deploy_alt_ft`, `ground_alt_ft`) say "ft"
for historical reasons but hold meters. The logbook keeps the stored values,
and `--units` converts them for display and CSV export.

* **Altitudes:** the altimeter rounds to the nearest 50 ft, while the tool shows
  the exact conversion. Stored altitudes are only accurate to about ±8 m
  (±26 ft) anyway.
* **Speeds:** decimals are dropped, the same as on the altimeter. A speed of 0
  means the jump never passed that altitude, and `list` shows "-".

## Trying it without an altimeter (Linux and macOS)

```sh
python3 -m python simulate --model atlas2 --jumps 8
# in another terminal, using the port path printed above:
python3 -m python --fast --port /dev/ttys005 download --logbook /tmp/sim-logbook.json
```

## Using it from Python

```python
import sys
sys.path.insert(0, "/path/to/Alti-2-Data-Exporter")   # the folder that contains python/
from python.device import Alti2Device
from python.units import to_units

with Alti2Device("/dev/cu.usbserial-XXXXXXXX") as dev:
    print(dev.info.model, dev.info.serial, dev.info.version)
    result = dev.download()          # works out the key, reads name tables, jumps and charts
    for jump in result.jumps:
        s = jump.summary
        print(s.jump_no, s.date, to_units(s.exit_alt_ft, "alt"), "ft", jump.jump_type)
        if jump.profile:
            print(jump.profile.points[:5])   # (seconds from exit, altitude in meters)
```

## Files

| File | Purpose |
|---|---|
| `cli.py` | The commands and options. |
| `device.py` | A session with one altimeter: connect, work out the key, download. |
| `protocol.py` | The serial protocol: packets, encryption, commands. |
| `keys.py` | Encryption key derivation and the list of candidate keys. |
| `xtea.py` | The XTEA cipher. |
| `records.py` | Decoding the jump, altitude chart and name table records. |
| `logbook.py` | The JSON logbook and CSV export. |
| `units.py` | Unit conversion, average speed. |
| `serialport.py` | Serial port access (pyserial or a built-in POSIX backend) and port discovery. |
| `simulator.py` | A software model of an altimeter for testing. |

## License

Public domain ([The Unlicense](../LICENSE)).
