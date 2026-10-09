/* alti2sim.js - software model of an Alti-2 altimeter (port of simulator.py).
 *
 * Removed from the web app so the page only talks to real devices; kept here for
 * development and testing without hardware.  Load it after export.js:
 *
 *   <script src="js/export.js"></script>
 *   <script src="js/alti2sim.js"></script>
 *
 * then, e.g. from the browser console:
 *
 *   const { Alti2Device, SimulatedDevice, SimLink, sampleJumps } = Alti2Export;
 *   const sim = new SimulatedDevice("atlas2", sampleJumps(8, true));
 *   const dev = new Alti2Device(async () => new SimLink(sim), { fast: true });
 *   await dev.connect(); await dev.establishKey(); const res = await dev.download();
 */
(function () {
  "use strict";
  const core = window.Alti2Export;
  if (!core) throw new Error("alti2sim.js: load export.js first");
  const { XTEA, PRODUCT_CODES, SCHEDULES, buildKey, encodeSummary, encodeProfile, encodeNameTable, ByteQueue, ProtocolError,
    toHex, encodeTime, decodeTime, localIso, NAME_TABLES, JUMP_COUNT_ADDRESS, SUMMARY_RECORD_SIZE, PROFILE_RECORD_SIZE,
    PACKET_SIZE, CMD_READ_EEPROM, CMD_READ_INFO_MEM, CMD_READ_TIME, CMD_KEEP_ALIVE, CMD_EXIT, CMD_SET_TIME } = core;

  const sleep = (s) => new Promise((r) => setTimeout(r, Math.max(0, s * 1000)));
  const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, "0");
  function u16(b, off) { return b[off] | (b[off + 1] << 8); }
  function u32(b, off) { return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0; }
  function putU16(b, off, v) { b[off] = v & 0xFF; b[off + 1] = (v >>> 8) & 0xFF; }
  function putU32(b, off, v) { for (let i = 0; i < 4; i++) b[off + i] = (v >>> (8 * i)) & 0xFF; }

  // A software model of the device, to try the page without hardware (port of simulator.py).
  const SIM_MODELS = {
    atlas2: [5, 12, "atlas2", "doc"],
    atlas: [4, 7, "atlas1", "doc"],
    "atlas-newfw": [5, 7, "atlas2", "doc"],
    neptune3: [3, 5, "legacy", "legacy"],
    "neptune3-newfw": [5, 5, "atlas2", "doc"],
    neptune2: [2, 1, "legacy", "legacy"],
    ma12: [4, 8, "atlas1", "doc"],
  };

  function buildInfo(family, product, { serial = "23007423", version = [1, 0, 9], hardwareId = 1, fram = 1,
    detailedAddr = 0x12000, totalJumps = 0, totalSeconds = 0, summaryAddr = 0x520 } = {}) {
    const raw = new Uint8Array(32);
    raw[0] = 0x1E; raw[1] = 0; raw[2] = family;
    raw[3] = ((version[0] & 0xF) << 4) | (version[1] & 0xF);
    raw[4] = version[2];
    const s = serial.slice(0, 9).padEnd(9, " ");
    for (let i = 0; i < 9; i++) raw[5 + i] = s.charCodeAt(i);
    raw[14] = hardwareId; raw[15] = product; raw[16] = fram;
    putU32(raw, 17, detailedAddr); putU16(raw, 21, totalJumps); putU32(raw, 23, totalSeconds); putU32(raw, 27, summaryAddr);
    let sum = 0;
    for (let i = 1; i < 31; i++) sum += raw[i];
    raw[31] = sum & 0xFF;
    return raw;
  }

  function sampleProfile(exitAlt = 13000, deployAlt = 3500, freefallS = 45, step = 0.75) {
    const ffStart = 20.0;
    const pts = [[0, exitAlt], [8, exitAlt], [16, exitAlt]];
    let alt = exitAlt, v = 0, t = ffStart;
    pts.push([t, exitAlt]);
    while (alt > deployAlt && t < ffStart + freefallS) {
      v = Math.min(150, v + 32 * step);
      alt -= v * step;
      t += step;
      pts.push([t, Math.trunc(alt)]);
    }
    for (let i = 0; i < 8; i++) { alt -= 120; t += 10; pts.push([t, Math.max(0, Math.trunc(alt))]); }
    return [ffStart, pts];
  }

  function sampleJumps(n, newEpoch) {
    const start = newEpoch ? Date.UTC(2024, 4, 4, 9, 30) : Date.UTC(2014, 4, 4, 9, 30);
    const out = [];
    for (let i = 0; i < n; i++) {
      const exitAlt = 12800 + (i % 3) * 800, deploy = 3200 + (i % 2) * 400, ff = 40 + (i % 10);
      const [ffs, pts] = sampleProfile(exitAlt, deploy, ff);
      const d = new Date(start + (Math.floor(i / 4) * 24 + (i % 4) * 2) * 3600e3);
      out.push([{
        jump_no: 1000 + i,
        date: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() },
        exit_alt_ft: exitAlt, deploy_alt_ft: deploy, freefall_time_s: ff, canopy_time_s: 180 + i,
        ground_alt_ft: 600, tas_3k: 50 + (i % 5), tas_6k: 52, tas_9k: 54, tas_12k: 55,
        jump_type_idx: i % 4, jump_type_custom: false, aircraft_idx: i % 3, dropzone_idx: i % 2,
        profile_slot: i, deleted: i === 2, fw_version: newEpoch ? "1.0.9" : "2.1.3",
      }, ffs, pts]);
    }
    return out;
  }

  class SimulatedDevice {
    constructor(model = "atlas2", jumps = null, { serial = "23007423", log } = {}) {
      const [family, product, codes, sched] = SIM_MODELS[model];
      this.model = model;
      this.newEpoch = family === 5;
      this.log = log || (() => {});
      this.summaryAddr = 0x520; this.detailedAddr = 0x12000;
      this.jumps = jumps || sampleJumps(5, this.newEpoch);
      const totalSeconds = this.jumps.reduce((a, j) => a + j[0].freefall_time_s, 0);
      this.info = buildInfo(family, product, { serial, totalJumps: this.jumps.length, totalSeconds,
        detailedAddr: this.detailedAddr, summaryAddr: this.summaryAddr });
      this.key = buildKey(this.info, PRODUCT_CODES[codes], SCHEDULES[sched]);
      this.cipher = new XTEA(this.key);
      this.memory = new Uint8Array(0x40000);
      const tables = { jump_types: ["FrEE", "AFF", "TAN", "STU", "PHO", "SLO"], aircraft: ["Otter", "Caravan", "C182"], dropzones: ["Eloy", "Perris"] };
      for (const [name, addr] of Object.entries(NAME_TABLES)) this.memory.set(encodeNameTable(tables[name] || []), addr);
      putU16(this.memory, JUMP_COUNT_ADDRESS, this.jumps.length);
      this.jumps.forEach(([rec, ffs, pts], i) => {
        this.memory.set(encodeSummary(rec, this.newEpoch), this.summaryAddr + i * SUMMARY_RECORD_SIZE);
        // the slot's jump number field holds the record index (what the downloader checks against)
        this.memory.set(encodeProfile(i, ffs, pts), this.detailedAddr + rec.profile_slot * PROFILE_RECORD_SIZE);
      });
      this.setTimeCalls = [];
      this.exited = false;
      this.reset();
    }
    reset() { this.mode = "wake"; this.rx = []; this.outbox = []; }

    /* Feed one byte from the host; returns bytes the device sends back. */
    receive(b) {
      const out = [];
      const send = (bytes) => { for (const x of bytes) out.push(x); };
      if (this.mode === "wake") {
        this.rx.push(b);
        if (this.rx.length >= 6) {
          this.rx = [];
          this.log("sim: wake-up received, sending info");
          send(new TextEncoder().encode(toHex(this.info) + "\r\n"));
          this.mode = "session";
        }
      } else if (this.mode === "sending") {
        if (b !== 0x31) { this.log(`sim: missing host ack (0x${hex2(b)})`); this.reset(); }
        else if (this.outbox.length) send(this.cipher.encrypt(this.outbox.shift()));
        else this.mode = "session";
      } else {
        this.rx.push(b);
        if (this.rx.length === PACKET_SIZE) { const pkt = Uint8Array.from(this.rx); this.rx = []; this._packet(pkt, send); }
      }
      return out;
    }
    _packet(pkt, send) {
      const plain = this.cipher.decrypt(pkt), n = plain[0];
      if (n > 30) { this.log("sim: length error (wrong key?)"); return send([0x32]); }
      const payload = plain.subarray(1, 1 + n);
      if ((payload.reduce((a, x) => a + x, 0) & 0xFF) !== plain[1 + n]) { this.log("sim: checksum error"); return send([0x33]); }
      send([0x31]);
      if (!payload.length) return send([0x37]);
      const cmd = payload[0];
      if (cmd === CMD_READ_EEPROM || cmd === CMD_READ_INFO_MEM) {
        const addr = u32(payload, 1), length = u16(payload, 5);
        this.log(`sim: read 0x${addr.toString(16).toUpperCase()} len ${length}`);
        send([0x35]);
        const npackets = Math.ceil((length + 4) / PACKET_SIZE);
        const stream = new Uint8Array(npackets * PACKET_SIZE);
        putU32(stream, 0, addr);
        stream.set(this.memory.subarray(addr, addr + length), 4);
        for (let i = 0; i < npackets; i++) this.outbox.push(stream.subarray(i * 32, (i + 1) * 32));
        send(this.cipher.encrypt(this.outbox.shift()));
        this.mode = "sending";
      } else if (cmd === CMD_SET_TIME) {
        const dt = decodeTime(payload.subarray(1, 9));
        this.setTimeCalls.push(dt);
        this.log("sim: clock set to " + localIso(dt));
        send([0x35]);
      } else if (cmd === CMD_READ_TIME) {
        send([0x35]);
        const p = new Uint8Array(32);
        p.set(encodeTime(new Date()));
        this.outbox.push(p);
        send(this.cipher.encrypt(this.outbox.shift()));
        this.mode = "sending";
      } else if (cmd === CMD_KEEP_ALIVE) {
        send([0x35]);
      } else if (cmd === CMD_EXIT) {
        send([0x35]);
        this.exited = true;
        this.log("sim: exit");
        this.reset();
      } else send([0x36]);
    }
  }

  /* In-page link to a SimulatedDevice. */
  class SimLink {
    constructor(sim) { this.sim = sim; this.q = new ByteQueue(); }
    async write(data, interByteDelay = 0) {
      if (this.q.closed) throw new ProtocolError("port closed");
      for (const b of data) {
        const out = this.sim.receive(b);
        if (out.length) setTimeout(() => this.q.push(out), 1);
        if (interByteDelay > 0) await sleep(interByteDelay);
      }
    }
    read(n, timeout) { return this.q.read(n, timeout); }
    flushInput() { this.q.clear(); }
    async setDTR(on) { if (!on) this.sim.reset(); }
    async close() { this.q.close(); this.sim.reset(); }
  }

  Object.assign(core, { SIM_MODELS, buildInfo, sampleProfile, sampleJumps, SimulatedDevice, SimLink });
})();
