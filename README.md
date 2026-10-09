# Alti-2 Data Exporter

Download the jump log from an Alti-2 altimeter over USB, browse it, chart each
jump, and export it to CSV for Excel, Numbers or Google Sheets.

There are two versions. They read the same altimeters and share the same
logbook format:

* **Web page** (this README): runs entirely in your browser. Nothing is
  installed and nothing is uploaded.
* **Python command-line tool**: for scripting, or for computers without
  Chrome or Edge. See [python/README.md](python/README.md).

> **⚠ Warning.** Reading data is normally safe, but you use this software and
> the information it provides entirely at your own risk. The software is
> provided "as is", without warranty of any kind. The author is not liable for
> any damage, malfunction, injury or other issues resulting from its use.
> Always check that your altimeter works correctly before you jump.

Is your altimeter not supported? Questions, comments or concerns? Email
[staff@skydiving.is](mailto:staff@skydiving.is).

## Supported altimeters

Atlas, Atlas 2, Neptune II, Neptune III / IIIA and MA-12. These all use the
encrypted protocol described in
[Alti-2/atlas2-communications](https://github.com/Alti-2/atlas2-communications).
The original Neptune I uses a different, unencrypted protocol and is not
supported.

## What you need

* **Google Chrome or Microsoft Edge on a computer.** The page talks to the
  altimeter through the Web Serial API, which Safari, Firefox and phone
  browsers don't have.
* **A USB data cable** for your altimeter.
* **The page served over `https://` or from `http://localhost`.** Browsers
  only allow Web Serial on secure pages. To run it locally:

  ```sh
  python3 -m http.server 8000
  ```

  Run this in the repository folder, then open <http://localhost:8000> in
  Chrome or Edge.

## How to use it

1. Open the page and accept the warning.
2. Plug in your altimeter.
3. Click **Select device** and pick your altimeter in the list that pops up.
   It usually shows up as a USB serial device, for example
   `cu.usbserial.A2QDB3BF` or `tty.usbserial.A2QDB3BF`. The page connects
   straight away. After about 8 seconds it shows the model, serial number,
   software version, total jumps and total freefall time.
4. Click **Download jumps**. A progress bar shows the download. Keep the cable
   plugged in until the message under the button says it's done.
5. Browse your jumps in the logbook, and click one to see its chart.

The same steps are shown at the top of the page under **How to use this
page**.

## Features

### Getting started

* **Safety warning:** shown when the page opens, and the page can't be used
  until it's accepted. Tick **Do not show again** to skip it for a year. This
  is stored in a cookie, so it only works when the page is served over https
  or localhost.
* **Built-in instructions:** a **How to use this page** panel at the top, with
  the steps, a browser check, and tips on data storage and troubleshooting.
  It can be collapsed, and the page remembers that.

### Connecting and downloading

* **Select device:** picks the altimeter and detects it straight away. The
  model, serial number, software version, total jumps and total freefall time
  appear when it's found. If detection fails, the page says why and what to
  try.
* **Download jumps:** unlocks once the altimeter has been detected. It reads
  every jump with its altitude chart, skips jumps deleted on the altimeter,
  and never changes anything on the altimeter. A progress bar shows how it's
  going, and **Stop** cancels it.
* **Status messages:** each step shows a short status line, for example how
  many jumps were downloaded and how many were new.
* **Unplugging:** if the altimeter is unplugged, the page notices and locks
  the download button again.

### The logbook table

* **Columns:** Jump # and Date always show. Exit, Deploy, Freefall, Total
  freefall and Notes are on by default. Use **Columns** to show or hide the
  rest: canopy time, ground altitude, jump type, aircraft, dropzone, average
  speed, speed at 3k/6k/9k/12k ft, chart, device, serial number, firmware,
  deleted and import time. **Reset to default** and **Show all** are in the
  same panel.
* **Notes:** type straight into the Notes column. A note is saved when you
  press Enter or click or tab away, and Esc undoes your typing.
* **Sorting:** click a column heading to sort by it, and click again to reverse.
  The table starts sorted by jump number, highest first.
* **Column widths:** drag the divider on a header's right edge. Double-click it,
  or use **Reset column widths**, to go back to automatic widths.
* **Units:** switch between **Imperial (ft, mph)** and **Metric (m, km/h)**.
* **Total freefall:** a running total of freefall time: each jump's own freefall
  time plus that of every jump with a lower jump number. Deleted jumps don't
  count.
* **Average speed:** worked out as (exit − deploy) ÷ freefall time.
* **Easy to read:** rows alternate colours, and a speed shows "–" if the jump
  never passed that altitude.

The page remembers your column choices, widths and units in each browser.

### Jump details and chart

Click a jump to open its details:

* **Notes:** the same notes as in the table. Type and click **Save notes**.
* **Altitude chart:** altitude against time, with dashed **Exit** and **Canopy**
  lines.
* **Hover readout:** like a stock chart, a crosshair follows the pointer and
  shows the altitude, time from exit, descent rate and phase (before exit,
  freefall, under canopy) at that moment.
* **Measure a range:** click and drag across the chart to see the average
  speed, time span and altitude lost between two points. Ends near the Exit or
  Canopy lines snap to them, so exit to canopy gives the average freefall
  speed. A click, **✕ Clear** or Esc clears the selection. A tip above the
  chart explains this.
* **Keyboard:** with the chart focused (Tab), the arrow keys step through the
  points, Shift + arrow keys select a range, and Esc clears it.

### Exporting and importing

| Button | What you get |
|---|---|
| **Export CSV** | Every data point for every jump, whatever columns are shown, in the selected units. |
| **Export JSON** | The whole logbook in its raw stored form. Use it for backups and for moving to another browser. |
| **Import JSON…** | Loads a `logbook.json` back in, from this page or the Python tool. Jumps already in the logbook are updated and their notes are kept. |
| **Clear** | Deletes every jump from the browser's logbook, after asking. |
| **Export profile CSV** (jump details) | Time and altitude for every point of one jump's altitude chart, in the selected units. |
| **Export JSON** (jump details) | One jump in its raw stored form. |

CSV column names say which unit they use, for example `exit_alt_ft` or
`exit_alt_m`, and `tas_3k_mph` or `tas_3k_kmh`. After the standard columns the
CSV adds any other stored fields, then `freefall_start_s`, `avg_speed_*` and
`total_freefall_s`. The Python tool writes exactly the same columns.

## Where your data is kept

The logbook is stored in your browser (IndexedDB), on this computer only.
Nothing is sent anywhere. Clearing your browser data erases the logbook, so
use **Export JSON** now and then to keep a backup.

## Units

The altimeter stores altitudes in **meters** and the four speed values in
**meters per second**. Both were checked against an Atlas 2's own display, and
the chart data was checked against the stored exit altitude. The stored field
names (`exit_alt_ft`, `deploy_alt_ft`, `ground_alt_ft`) say "ft" for
historical reasons but hold meters. Both versions keep the stored values and
convert them only for display and CSV export.

Expect small differences from what the altimeter shows:

* **Altitudes:** the altimeter rounds to the nearest 50 ft, while the page shows
  the exact conversion. Stored altitudes are only accurate to about ±8 m
  (±26 ft) anyway.
* **Speeds:** decimals are dropped, the same as on the altimeter.
* **Average speed:** the altimeter doesn't store it, so it's calculated. It can
  be about 1 mph off the altimeter's figure.

## Files

| File | Purpose |
|---|---|
| `index.html` | The page. It only loads `js/export.js`. |
| `js/export.js` | Everything else: the device protocol, the logbook, and the user interface. |
| `js/alti2sim.js` | A software model of an altimeter, for development without hardware. The page doesn't load it. |
| `python/` | The Python command-line version. See [python/README.md](python/README.md). |

`export.js` exposes its internals as `window.Alti2Export` for use from the
browser console or other scripts.

### Trying it without an altimeter

Load the simulator after `export.js` (for example by adding
`<script src="js/alti2sim.js"></script>` to a copy of `index.html`), then run
this in the browser console:

```js
const { Alti2Device, SimulatedDevice, SimLink, sampleJumps } = Alti2Export;
const sim = new SimulatedDevice("atlas2", sampleJumps(8, true));
const dev = new Alti2Device(async () => new SimLink(sim), { fast: true });
await dev.connect(); await dev.establishKey();
const result = await dev.download();
```

## Protocol notes

* **Serial settings:** 57600 baud, 8N1, RTS/CTS hardware flow control, DTR
  raised. Bytes go out with a 1.5 ms gap.
* **Wake-up:** after opening the port, the page waits 5 s, sends 6 wake-up
  bytes and waits 2.5 s. The altimeter then sends its Info message as ASCII
  hex, which gives the model, serial number, firmware and totals.
* **Encryption:** commands and replies use XTEA. The key is derived from three
  product code bytes plus the Info message. The documented key layouts are
  ambiguous, so the page tries a list of candidate keys, most likely first.
* **Reading data:** the page reads the name tables (jump types, aircraft,
  dropzones), the 22-byte summary records and the 224-byte altitude profile
  records from EEPROM.

## Known limitations

* So far only tested with an Atlas 2.
* Neptune I is not supported.

## License

Public domain ([The Unlicense](LICENSE)).
