
(function () {
  "use strict";

  // ---------------------------------------------------------------- helpers
  const sleep = (s) => new Promise((r) => setTimeout(r, Math.max(0, s * 1000)));
  const now = () => performance.now() / 1000;
  const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, "0");
  const toHex = (bytes, sep = " ") => Array.from(bytes, hex2).join(sep);
  const pad2 = (n) => String(n).padStart(2, "0");
  const hms = (s) => `${Math.floor(s / 3600)}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
  // Settle with `fallback` if the promise has not settled after `s` seconds.
  const withTimeout = (p, s, fallback) => Promise.race([p, sleep(s).then(() => fallback)]);

  function u16(b, off) { return b[off] | (b[off + 1] << 8); }
  function u32(b, off) { return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0; }
  function putU16(b, off, v) { b[off] = v & 0xFF; b[off + 1] = (v >>> 8) & 0xFF; }
  function putU32(b, off, v) { for (let i = 0; i < 4; i++) b[off + i] = (v >>> (8 * i)) & 0xFF; }
  function concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
  function hexToBytes(t) {
    if (t.length % 2 || /[^0-9a-fA-F]/.test(t)) throw new Error("invalid hex: " + t);
    const o = new Uint8Array(t.length / 2);
    for (let i = 0; i < o.length; i++) o[i] = parseInt(t.substr(i * 2, 2), 16);
    return o;
  }
  function bytesEqual(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }

  class ProtocolError extends Error {}
  class DeviceNack extends ProtocolError {
    constructor(code, stage) {
      const table = stage === "packet" ? PACKET_RESPONSES : COMMAND_RESPONSES;
      super(`${stage}: device answered 0x${hex2(code)} (${table[code] || "unknown response"})`);
      this.code = code; this.stage = stage;
    }
  }
  class KeyRejected extends DeviceNack {}

  // ---------------------------------------------------------------- xtea
  // 16 rounds, delta 0x9E3779B9, little-endian words.
  const DELTA = 0x9E3779B9, ROUNDS = 16;

  class XTEA {
    constructor(key) {
      if (key.length !== 16) throw new Error("XTEA key must be 16 bytes, got " + key.length);
      this.key = Uint8Array.from(key);
      this.k = [0, 4, 8, 12].map((o) => u32(this.key, o));
    }
    _run(data, enc) {
      if (data.length % 8) throw new Error("data length must be a multiple of 8, got " + data.length);
      const k = this.k, out = new Uint8Array(data.length);
      for (let off = 0; off < data.length; off += 8) {
        let v0 = u32(data, off), v1 = u32(data, off + 4);
        if (enc) {
          let s = 0;
          for (let i = 0; i < ROUNDS; i++) {
            v0 = (v0 + ((((v1 << 4) ^ (v1 >>> 5)) + v1) ^ (s + k[s & 3]))) >>> 0;
            s = (s + DELTA) >>> 0;
            v1 = (v1 + ((((v0 << 4) ^ (v0 >>> 5)) + v0) ^ (s + k[(s >>> 11) & 3]))) >>> 0;
          }
        } else {
          let s = (DELTA * ROUNDS) >>> 0;
          for (let i = 0; i < ROUNDS; i++) {
            v1 = (v1 - ((((v0 << 4) ^ (v0 >>> 5)) + v0) ^ (s + k[(s >>> 11) & 3]))) >>> 0;
            s = (s - DELTA) >>> 0;
            v0 = (v0 - ((((v1 << 4) ^ (v1 >>> 5)) + v1) ^ (s + k[s & 3]))) >>> 0;
          }
        }
        putU32(out, off, v0); putU32(out, off + 4, v1);
      }
      return out;
    }
    encrypt(d) { return this._run(d, true); }
    decrypt(d) { return this._run(d, false); }
  }


  const PRODUCT_CODES = {
    atlas2: [0xAA, 0x69, 0x44],
    atlas1: [0x38, 0x99, 0xCF],
    legacy: [0x4E, 0x75, 0x7E],
    juno: [0x8D, 0xAF, 0x11],
  };
  const SCHEDULES = {
    doc: ["c0", 23, 6, 13, 24, 22, 12, "c1", 7, 8, 10, "c2", 9, 11, 26, 25],
    legacy: ["c0", 8, 26, 24, 6, 25, 23, 13, 10, "c1", 7, 22, 9, 11, "c2", 21],
  };

  function buildKey(info, codes, schedule) {
    if (info.length < 31) throw new Error(`Info message too short (${info.length} bytes)`);
    const c = { c0: codes[0], c1: codes[1], c2: codes[2] };
    return Uint8Array.from(schedule, (src) => (typeof src === "string" ? c[src] : info[src]));
  }

  function keyCandidates(info) {
    const family = info[2], product = info[15];
    const order = [];
    if (family === 5) order.push(["atlas2", "doc"]);
    else if (family === 4) order.push(["atlas1", "doc"], ["legacy", "doc"]);
    else if (family === 2 || family === 3) {
      order.push(["legacy", "legacy"]);
      if (family === 3 && product !== 6) order.push(["atlas2", "doc"]);
    }
    order.push(["legacy", "doc"], ["atlas2", "doc"], ["juno", "doc"]);
    for (const codes of Object.keys(PRODUCT_CODES)) for (const sched of Object.keys(SCHEDULES)) order.push([codes, sched]);
    const seen = new Set(), result = [];
    for (const [codes, sched] of order) {
      const label = `${codes}/${sched}`;
      if (seen.has(label)) continue;
      seen.add(label);
      result.push([label, buildKey(info, PRODUCT_CODES[codes], SCHEDULES[sched])]);
    }
    return result;
  }

  function candidatesWithOverride(info, override) {
    const t = override.replace(/[\s,:]/g, "");
    let first;
    if (t.length === 32) first = [["manual", hexToBytes(t)]];
    else if (t.length === 6) {
      const codes = hexToBytes(t);
      first = Object.entries(SCHEDULES).map(([name, sched]) => [`codes-${t.toUpperCase()}/${name}`, buildKey(info, codes, sched)]);
    } else throw new Error("expected 32 hex digits (full key) or 6 hex digits (3 product codes)");
    const rest = keyCandidates(info).filter(([, k]) => !first.some(([, f]) => bytesEqual(f, k)));
    return first.concat(rest);
  }

  // ---------------------------------------------------------------- records
  const SUMMARY_RECORD_SIZE = 22;
  const PROFILE_RECORD_SIZE = 224;
  const JUMP_COUNT_ADDRESS = 14;
  const NAME_TABLE_SIZE = 322;
  const NAME_TABLES = { jump_types: 728, aircraft: 406, dropzones: 84 };

  // Dates are plain {year, month, day, hour, minute} objects (device local time, no zone).
  function makeDate(year, month, day, hour, minute) {
    // Normalise a month overflow the way Python's floor division does, then validate like datetime().
    const d = new Date(Date.UTC(year, month - 1, day, hour, minute));
    if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 ||
        d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return { year, month, day, hour, minute };
  }
  const isoMinutes = (d) => d ? `${d.year}-${pad2(d.month)}-${pad2(d.day)}T${pad2(d.hour)}:${pad2(d.minute)}` : null;

  function words(data, n) { const w = []; for (let i = 0; i < n; i++) w.push(u16(data, i * 2)); return w; }

  function parseSummary(data, newEpoch, monthOffset = 0) {
    if (data.length < SUMMARY_RECORD_SIZE) throw new Error(`summary record needs 22 bytes, got ${data.length}`);
    const w = words(data, 11);
    const months = (w[1] & 0x7F) - 1;
    const year = (newEpoch ? 2015 : 2007) + Math.floor(months / 12);
    const month = (((months % 12) + 12) % 12) + 1 + monthOffset;
    const date = makeDate(year, month, (w[6] & 0x7C00) >> 10, (w[3] & 0x7C0) >> 6, w[3] & 0x3F);
    const tas = (w[5] & 0xFFF) * 0x10000 + w[4];
    const fw = `${w[10] & 0xF}.${(w[3] & 0x7800) >> 11}.${(w[2] & 0xFC00) >> 10}`;
    return {
      jump_no: w[0],
      date,
      exit_alt_ft: (w[6] & 0x3FF) * 16,
      deploy_alt_ft: (w[7] & 0x3FF) * 16,
      freefall_time_s: w[2] & 0x3FF,
      canopy_time_s: w[8] & 0xFFF,
      ground_alt_ft: (w[9] & 0x3FF) * 4 - 640,
      tas_3k: tas & 0x7F,
      tas_6k: (tas >>> 7) & 0x7F,
      tas_9k: (tas >>> 14) & 0x7F,
      tas_12k: (tas >>> 21) & 0x7F,
      jump_type_idx: (w[1] & 0x1F00) >> 8,
      jump_type_custom: !!(w[1] & 0x8000),
      aircraft_idx: ((w[3] & 0x8000) >> 11) | ((w[5] & 0xF000) >> 12),
      dropzone_idx: (w[7] & 0x7C00) >> 10,
      profile_slot: ((w[8] & 0xC000) >> 8) | ((w[9] & 0xFC00) >> 10),
      deleted: !!(w[1] & 0x80),
      fw_version: fw,
    };
  }
  const fwTuple = (rec) => rec.fw_version.split(".").map(Number);

  function encodeSummary(rec, newEpoch) {
    const base = newEpoch ? 2015 : 2007;
    const d = rec.date || { year: base, month: 1, day: 1, hour: 0, minute: 0 };
    const months = (d.year - base) * 12 + (d.month - 1) + 1;
    const [major, minor, patch] = fwTuple(rec);
    const tas = (rec.tas_3k & 0x7F) | ((rec.tas_6k & 0x7F) << 7) | ((rec.tas_9k & 0x7F) << 14) | ((rec.tas_12k & 0x7F) << 21);
    const w = new Array(11).fill(0);
    w[0] = rec.jump_no & 0xFFFF;
    w[1] = (months & 0x7F) | (rec.deleted ? 0x80 : 0) | ((rec.jump_type_idx & 0x1F) << 8) | (rec.jump_type_custom ? 0x8000 : 0);
    w[2] = (rec.freefall_time_s & 0x3FF) | ((patch & 0x3F) << 10);
    w[3] = (d.minute & 0x3F) | ((d.hour & 0x1F) << 6) | ((minor & 0xF) << 11) | (((rec.aircraft_idx >> 4) & 1) << 15);
    w[4] = tas & 0xFFFF;
    w[5] = ((tas >>> 16) & 0xFFF) | ((rec.aircraft_idx & 0xF) << 12);
    w[6] = (Math.floor(rec.exit_alt_ft / 16) & 0x3FF) | ((d.day & 0x1F) << 10);
    w[7] = (Math.floor(rec.deploy_alt_ft / 16) & 0x3FF) | ((rec.dropzone_idx & 0x1F) << 10);
    w[8] = (rec.canopy_time_s & 0xFFF) | (((rec.profile_slot >> 6) & 0x3) << 14);
    w[9] = (Math.floor((rec.ground_alt_ft + 640) / 4) & 0x3FF) | ((rec.profile_slot & 0x3F) << 10);
    w[10] = major & 0xF;
    const out = new Uint8Array(22);
    w.forEach((v, i) => putU16(out, i * 2, v));
    return out;
  }

  const s8 = (v) => (v & 0x80 ? v - 256 : v);

  function parseProfile(data) {
    if (data.length % 2) throw new Error("profile record length must be even");
    const w = words(data, data.length / 2);
    if (w.length < 4) throw new Error("profile record too short");
    const ffStart = w[0] === 0xFFFF ? 60.0 : w[0] / 4;
    const raw = [];
    let t = w[3] / 4, alt = w[2];
    raw.push([t, alt]);
    let i = 4;
    while (i < w.length) {
      const code = (w[i] & 0xF000) >> 12;
      if (code <= 7) {
        t += s8(w[i] >> 8) / 4;
        alt -= s8(w[i] & 0xFF);
        raw.push([t, alt]);
        i += 1;
      } else if (code === 8) {
        i += 1;
      } else if (code === 15) {
        break;
      } else {
        if (i + 1 >= w.length) break;
        t = w[i + 1] / 4;
        const v = w[i] & 0xFFF;
        alt = code === 10 ? v * 2 : code === 11 ? v * 4 : code === 12 ? v - 0x1000 : v;
        raw.push([t, alt]);
        i += 2;
      }
    }
    const points = [];
    let lastT = null;
    for (const [tt, a] of raw) {
      if (lastT !== null && tt === lastT) continue;
      lastT = tt;
      const rel = Math.round((tt - ffStart) * 100) / 100;
      if (rel < -30) continue;
      points.push([rel, a]);
    }
    return { jump_no: w[1], freefall_start_s: ffStart, points };
  }

  function encodeProfile(jumpNo, ffStart, points) {
    const w = [Math.round(ffStart * 4) & 0xFFFF, jumpNo & 0xFFFF];
    if (!points.length) points = [[0, 0]];
    const [t0, a0] = points[0];
    w.push(a0 & 0xFFFF, Math.round(t0 * 4) & 0xFFFF);
    let prevT = Math.round(t0 * 4), prevA = a0;
    for (let [t, a] of points.slice(1)) {
      const qt = Math.round(t * 4), dt = qt - prevT, da = prevA - a;
      if (dt >= 0 && dt <= 127 && da >= -128 && da <= 127) w.push((dt << 8) | (da & 0xFF));
      else if (a < 0) w.push(0xC000 | (a & 0xFFF), qt & 0xFFFF);
      else if (a < 0x1000) w.push(0x9000 | a, qt & 0xFFFF);
      else if (a < 0x2000) { w.push(0xA000 | (a >> 1), qt & 0xFFFF); a = (a >> 1) * 2; }
      else if (a < 0x4000) { w.push(0xB000 | (a >> 2), qt & 0xFFFF); a = (a >> 2) * 4; }
      else throw new Error(`altitude ${a} ft cannot be encoded (max 16380)`);
      prevT = qt; prevA = a;
    }
    w.push(0xF000);
    if (w.length > PROFILE_RECORD_SIZE / 2) throw new Error(`profile does not fit in ${PROFILE_RECORD_SIZE} bytes`);
    while (w.length < PROFILE_RECORD_SIZE / 2) w.push(0x8000);
    const out = new Uint8Array(PROFILE_RECORD_SIZE);
    w.forEach((v, i) => putU16(out, i * 2, v));
    return out;
  }

  // Name tables: byte 0 checksum, byte 1 count, then up to 32 entries of 10 bytes 7-bit ASCII.
  function parseNameTable(data) {
    if (data.length < 2) throw new Error("name table too short");
    const entries = [];
    for (let i = 0; i < Math.min(data[1], 32); i++) {
      const chunk = data.subarray(2 + i * 10, 12 + i * 10);
      if (chunk.length < 10) break;
      let name = "";
      for (const b of chunk) { const c = b & 0x7F; if (c === 0) break; name += String.fromCharCode(c); }
      entries.push(name.trim());
    }
    return entries;
  }
  function nameTableChecksum(data) {
    let s = 1;
    for (let i = 1; i < NAME_TABLE_SIZE; i++) s += data[i] || 0;
    return s & 0xFF;
  }
  function encodeNameTable(names) {
    const buf = new Uint8Array(NAME_TABLE_SIZE);
    buf[1] = names.length;
    names.slice(0, 32).forEach((n, i) => {
      for (let j = 0; j < Math.min(10, n.length); j++) buf[2 + i * 10 + j] = n.charCodeAt(j) & 0x7F;
    });
    buf[0] = nameTableChecksum(buf);
    return buf;
  }

  function summaryToDict(rec) {
    const d = Object.assign({}, rec);
    d.date = isoMinutes(rec.date);
    return d;
  }

  // ---------------------------------------------------------------- protocol
  const CMD_READ_EEPROM = 0xA0, CMD_READ_INFO_MEM = 0xA1, CMD_READ_TIME = 0xA2, CMD_KEEP_ALIVE = 0xA4,
    CMD_EXIT = 0xAF, CMD_SET_TIME = 0xB2;
  const ACK_PACKET = 0x31;
  const PACKET_RESPONSES = {
    0x30: "abort communication",
    0x31: "encrypted packet received",
    0x32: "packet length error (decrypted length exceeds maximum; keys probably differ)",
    0x33: "checksum error (malformed packet)",
    0x34: "overflow error (flow control failure)",
  };
  const COMMAND_RESPONSES = {
    0x35: "command executed",
    0x36: "unrecognized command",
    0x37: "invalid syntax",
    0x38: "EEPROM/FRAM write error",
    0x39: "flash erase error",
    0x41: "info memory address out of bounds",
    0x42: "flash write error",
  };
  const PACKET_SIZE = 32, MAX_PAYLOAD = 30;

  class InfoMessage {
    constructor(raw) {
      if (raw.length < 31) throw new ProtocolError(`Info message too short: ${raw.length} bytes`);
      const r = (this.raw = Uint8Array.from(raw.subarray(0, 32)));
      this.length = r[0];
      this.record_type = r[1];
      this.family = r[2];
      this.sw_rev = r[3] >> 4;
      this.sw_major = r[3] & 0x0F;
      this.sw_minor = r[4];
      this.serial = Array.from(r.subarray(5, 14), (b) => (b === 0xFF ? " " : String.fromCharCode(b))).join("").trim();
      this.hardware_id = r[14];
      this.product_id = r[15];
      this.fram_config = r[16];
      this.detailed_log_addr = u32(r, 17);
      this.total_jumps = u16(r, 21);
      this.total_jump_seconds = u32(r, 23);
      this.summary_log_addr = u32(r, 27);
      this.checksum = r.length > 31 ? r[31] : null;
    }
    get version() { return `${this.sw_rev}.${this.sw_major}.${this.sw_minor}`; }
    get model() {
      const f = this.family, p = this.product_id;
      if (f === 3) return p === 6 ? "Neptune IIIA" : "Neptune III";
      if (f === 4) return p === 7 ? "Atlas" : "MA-12";
      if (f === 5) return { 5: "Neptune III", 7: "Atlas", 12: "Atlas 2", 8: "MA-12", 9: "MA-12" }[p] || `Atlas 2 family (product ${p})`;
      return { 0: "Neptune I", 1: "unsupported", 2: "Neptune II" }[f] || `unknown family ${f}`;
    }
    get encrypted() { return this.family !== 0; }
    verifyChecksum() {
      let s = 0;
      for (let i = 1; i < 31; i++) s += this.raw[i];
      return (s & 0xFF) === this.raw[31];
    }
    toString() {
      return `InfoMessage(model=${this.model}, serial=${this.serial}, version=${this.version}, hw=${this.hardware_id}, ` +
        `product=${this.product_id}, jumps=${this.total_jumps}, jump_seconds=${this.total_jump_seconds}, ` +
        `summary@0x${this.summary_log_addr.toString(16).toUpperCase()}, detailed@0x${this.detailed_log_addr.toString(16).toUpperCase()})`;
    }
  }

  // Device time structure for B2 (set) and A2 (read); fields are local wall-clock values.
  function encodeTime(dt) {
    return Uint8Array.from([dt.getFullYear() % 256, dt.getFullYear() >> 8, dt.getMonth() + 1, dt.getDate(), 0,
      dt.getHours(), dt.getMinutes(), dt.getSeconds()]);
  }
  function decodeTime(d) { return new Date(u16(d, 0), d[2] - 1, d[3], d[5], d[6], d[7]); }

  function frame(payload) {
    const buf = new Uint8Array(PACKET_SIZE);
    buf[0] = payload.length;
    buf.set(payload, 1);
    buf[1 + payload.length] = payload.reduce((a, b) => a + b, 0) & 0xFF;
    return buf;
  }
  function readCommand(command, address, length) {
    const p = new Uint8Array(7);
    p[0] = command; putU32(p, 1, address); putU16(p, 5, length);
    return p;
  }

  class Alti2Protocol {
    constructor(link, log, interByteDelay) {
      this.link = link;
      this.cipher = null;
      this.log = log || (() => {});
      this.interByteDelay = interByteDelay == null ? Alti2Protocol.INTER_BYTE_DELAY : interByteDelay;
      this.lastResponse = new Uint8Array(0);
    }
    write(data) { return this.link.write(data, this.interByteDelay); }

    async readAvailable(wait) {
      let out = new Uint8Array(0);
      const deadline = now() + wait;
      while (now() < deadline) {
        const chunk = await this.link.read(64, Math.min(0.2, Math.max(0, deadline - now())));
        if (chunk.length) out = concat(out, chunk);
      }
      return out;
    }
    setKey(key) { this.cipher = new XTEA(key); }
    async drain(settle = 0.1) { await sleep(settle); this.link.flushInput(); }

    async readByte(timeout, hexMode = false) {
      const deadline = now() + (timeout == null ? Alti2Protocol.BYTE_TIMEOUT : timeout);
      for (;;) {
        const remaining = deadline - now();
        if (remaining <= 0) throw new ProtocolError("timeout waiting for data from device");
        const b = await this.link.read(1, remaining);
        if (!b.length) continue;
        if (hexMode && b[0] < 0x30) continue;
        return b[0];
      }
    }
    async readHexByte() {
      const hi = await this.readByte(null, true), lo = await this.readByte(null, true);
      const s = String.fromCharCode(hi, lo);
      if (!/^[0-9a-fA-F]{2}$/.test(s)) throw new ProtocolError(`expected hex digits, got ${JSON.stringify(s)}`);
      return parseInt(s, 16);
    }
    async readExact(n) {
      let out = new Uint8Array(0);
      while (out.length < n) {
        const chunk = await this.link.read(n - out.length, Alti2Protocol.BYTE_TIMEOUT);
        if (!chunk.length) throw new ProtocolError(`timeout: got ${out.length} of ${n} bytes`);
        out = concat(out, chunk);
      }
      return out;
    }

    // -- info message
    async wakeAndReadInfo(settle = 2.5) {
      await this.write(Alti2Protocol.WAKE_UP);
      await sleep(settle);
      return this.readInfo();
    }
    async readInfo() {
      const length = await this.readHexByte();
      if (length < 8 || length > 64) throw new ProtocolError(`implausible Info message length 0x${hex2(length)}`);
      const body = [length];
      let total = 0;
      for (let i = 0; i < length; i++) { const b = await this.readHexByte(); body.push(b); total += b; }
      const checksum = await this.readHexByte();
      body.push(checksum);
      if ((total & 0xFF) !== checksum)
        throw new ProtocolError(`Info message checksum mismatch: computed 0x${hex2(total & 0xFF)}, received 0x${hex2(checksum)}`);
      await this.drain();
      const info = new InfoMessage(Uint8Array.from(body));
      this.log("info: " + info);
      return info;
    }

    // -- packets
    async _expect(stage, good, keyStage = false) {
      const code = await this.readByte();
      this.lastResponse = concat(this.lastResponse, [code]);
      if (code !== good) {
        const extra = await this.readAvailable(0.3);
        this.lastResponse = concat(this.lastResponse, extra);
        this.log(`${stage} stage: device answered 0x${hex2(code)}${extra.length ? " followed by " + toHex(extra) : ""}`);
        if (keyStage && (code === 0x32 || code === 0x33)) throw new KeyRejected(code, stage);
        throw new DeviceNack(code, stage);
      }
    }
    async sendPacket(payload, keyStage = false) {
      if (!this.cipher) throw new ProtocolError("encryption key not set");
      if (payload.length > MAX_PAYLOAD) throw new Error("payload too long: " + payload.length);
      this.lastResponse = new Uint8Array(0);
      await this.write(this.cipher.encrypt(frame(payload)));
      await this._expect("packet", ACK_PACKET, keyStage);
      await this._expect("command", 0x35);
    }
    async readPacket() {
      const data = await this.readExact(PACKET_SIZE);
      await sleep(0.001);
      await this.write(Uint8Array.of(ACK_PACKET));
      return this.cipher.decrypt(data);
    }

    // -- commands
    /* A0/A1 read: first reply packet = 4 byte echoed address + 28 data bytes, then 32 data bytes per packet. */
    async readMemory(address, length, { command = CMD_READ_EEPROM, progress = null, keyStage = false } = {}) {
      if (length < 2 || length > 0xFFFF) throw new Error("length must be 2..65535");
      const npackets = Math.ceil((length + 4) / PACKET_SIZE);
      await this.sendPacket(readCommand(command, address, length), keyStage);
      const out = new Uint8Array(PACKET_SIZE * npackets);
      const first = await this.readPacket();
      const echoed = u32(first, 0);
      if (echoed !== address)
        throw new ProtocolError(`device echoed address 0x${echoed.toString(16).toUpperCase()}, expected 0x${address.toString(16).toUpperCase()}`);
      out.set(first.subarray(4), 0);
      if (progress) progress(1, npackets);
      for (let i = 1; i < npackets; i++) {
        out.set(await this.readPacket(), i * 32 - 4);
        if (progress) progress(i + 1, npackets);
      }
      return out.slice(0, length);
    }
    async readEepromChunked(address, length, chunk = 0x7F00, progress = null) {
      const out = new Uint8Array(length);
      let done = 0;
      while (done < length) {
        const n = Math.max(2, Math.min(chunk, length - done));
        const part = await this.readMemory(address + done, n);
        out.set(part.subarray(0, length - done), done);
        done += n;
        if (progress) progress(Math.min(done, length), length);
      }
      return out;
    }
    setTime(dt) { return this.sendPacket(concat([CMD_SET_TIME], encodeTime(dt))); }
    async readTime() {
      await this.sendPacket(Uint8Array.of(CMD_READ_TIME));
      let pkt = await this.readPacket();
      if (pkt[1] === CMD_READ_TIME) pkt = pkt.subarray(2);
      return decodeTime(pkt);
    }
    keepAlive() { return this.sendPacket(Uint8Array.of(CMD_KEEP_ALIVE)); }
    async exit() { try { await this.sendPacket(Uint8Array.of(CMD_EXIT)); } catch (e) { if (!(e instanceof ProtocolError)) throw e; } }
  }
  Alti2Protocol.WAKE_UP = new TextEncoder().encode("      ");   // six bytes; the device does not care what they are
  Alti2Protocol.BYTE_TIMEOUT = 5.0;
  Alti2Protocol.INTER_BYTE_DELAY = 0.0015;   // pause before every byte written

  // ---------------------------------------------------------------- device
  const MAX_SUMMARY_RECORDS = 2978;

  class Alti2Device {

    constructor(openLink, { log, fast = false, interByteDelay = null } = {}) {
      this.openLink = openLink;
      this.log = log || (() => {});
      this.link = null; this.proto = null; this.info = null; this.key = null; this.keyLabel = null;
      this.fast = fast;
      this.interByteDelay = interByteDelay;
      this.OPEN_SETTLE = 5.0; this.WAKE_SETTLE = 2.5; this.WAKE_RETRIES = 3;
      if (fast) {
        this.OPEN_SETTLE = this.WAKE_SETTLE = 0.2;
        if (interByteDelay == null) this.interByteDelay = 0;
      }
    }

    async connect() {
      this.link = await this.openLink();
      this.proto = new Alti2Protocol(this.link, this.log, this.interByteDelay);
      await this.link.setDTR(true);
      await sleep(this.OPEN_SETTLE);
      await this.proto.drain();
      let last = null;
      for (let attempt = 0; ; attempt++) {
        if (attempt >= this.WAKE_RETRIES) throw new ProtocolError(`device did not send the Info message (${last && last.message})`);
        try {
          this.info = await this.proto.wakeAndReadInfo(this.WAKE_SETTLE);
          break;
        } catch (e) {
          if (!(e instanceof ProtocolError)) throw e;
          last = e;
          this.log(`wake-up attempt ${attempt + 1} failed: ${e.message}`);
          await this.proto.drain(0.5);
          if (!this.fast) await sleep(2.0 * (attempt + 1));
        }
      }
      if (!this.info.verifyChecksum()) throw new ProtocolError("Info message checksum invalid");
      this.log(`connected to ${this.info.model} serial ${this.info.serial} firmware ${this.info.version}`);
      return this.info;
    }
    async reconnect() {
      await this.close(false);
      await sleep(this.fast ? 0.5 : 3.0);       // let the device notice DTR dropping
      return this.connect();
    }
    async close(sendExit = true) {
      if (this.proto && sendExit && this.key) { try { await this.proto.exit(); } catch (e) { /* ignore */ } }
      if (this.link) {
        try { await this.link.setDTR(false); } catch (e) { /* ignore */ }
        await this.link.close();
      }
      this.link = this.proto = this.key = null;
    }

    async establishKey(candidates) {
      if (!this.info) throw new ProtocolError("not connected");
      if (!this.info.encrypted) throw new ProtocolError(`${this.info.model} uses the unencrypted Neptune I protocol, which is not supported`);
      candidates = candidates || keyCandidates(this.info.raw);
      const attempts = [];
      for (const [label, key] of candidates) {
        this.proto.setKey(key);
        this.log(`trying key ${label} (${toHex(key, "")})`);
        try {
          await this.proto.readMemory(JUMP_COUNT_ADDRESS, 2, { keyStage: true });
          this.key = key; this.keyLabel = label;
          this.log("key accepted: " + label);
          return label;
        } catch (e) {
          if (!(e instanceof ProtocolError)) throw e;
          attempts.push(`${label}: ${e.message}`);
          if (e instanceof KeyRejected) await this.proto.drain(0.3);
          else if (e instanceof DeviceNack && e.code !== 0x30) await this.proto.drain(0.3);
          else await this._safeReconnect(attempts);   // device aborted or went quiet: start over
        }
      }
      throw new ProtocolError("no key accepted by the device:\n  " + attempts.join("\n  "));
    }
    async _safeReconnect(attempts) {
      try { await this.reconnect(); } catch (e) {
        throw new ProtocolError(`device stopped responding; reconnect failed (${e.message}). Attempts so far:\n  ${attempts.join("\n  ")}`);
      }
    }

    async jumpCount() { const d = await this.proto.readMemory(JUMP_COUNT_ADDRESS, 2); return d[0] | (d[1] << 8); }
    async readNameTables() {
      const tables = {};
      for (const [name, addr] of Object.entries(NAME_TABLES)) {
        const data = await this.proto.readMemory(addr, NAME_TABLE_SIZE);
        if (nameTableChecksum(data) !== data[0]) this.log(`warning: checksum mismatch in ${name} table`);
        tables[name] = parseNameTable(data);
      }
      return tables;
    }
    async readSummaryRecords(count, progress) {
      if (count > MAX_SUMMARY_RECORDS) throw new ProtocolError(`device reports ${count} records; maximum is ${MAX_SUMMARY_RECORDS}`);
      if (count === 0) return [];
      const raw = await this.proto.readEepromChunked(this.info.summary_log_addr, count * SUMMARY_RECORD_SIZE,
        1489 * SUMMARY_RECORD_SIZE, progress);
      const newEpoch = this.info.family === 5;
      const out = [];
      for (let i = 0; i < count; i++) out.push(parseSummary(raw.subarray(i * 22, (i + 1) * 22), newEpoch));
      return out;
    }
    async readProfile(slot) {
      return parseProfile(await this.proto.readMemory(this.info.detailed_log_addr + slot * PROFILE_RECORD_SIZE, PROFILE_RECORD_SIZE));
    }
    setClock(dt) { return this.proto.setTime(dt || new Date()); }

    /* Download the complete jump log. */
    async download({ withProfiles = true, includeDeleted = false, minJumpNo = 0, progress = null } = {}) {
      if (!this.key) await this.establishKey();
      const result = { info: this.info, keyLabel: this.keyLabel, jumps: [], skipped: [], tables: {}, warnings: [] };
      const prog = (stage, a, b) => progress && progress(stage, a, b);
      result.tables = await this.readNameTables();
      prog("tables", 1, 1);
      const count = await this.jumpCount();
      this.log(`device holds ${count} summary records`);
      const records = await this.readSummaryRecords(count, (a, b) => prog("summary", a, b));
      let profilesOk = withProfiles;
      const total = records.length;
      for (let idx = total - 1; idx >= 0; idx--) {         // newest first
        const rec = records[idx];
        prog("jumps", total - idx, total);
        let skip = rec.deleted && !includeDeleted;
        if (rec.jump_no <= minJumpNo) skip = true;
        // skip records written by firmware 2.9.0-2.9.8 on product 5 (known bad records)
        const fw = fwTuple(rec);
        if (fw[0] === 2 && fw[1] === 9 && fw[2] < 9 && this.info.product_id === 5) skip = true;
        if (skip) { result.skipped.push(rec); continue; }
        const t = result.tables;
        const jump = {
          summary: rec, profile: null, device_serial: this.info.serial, device_model: this.info.model,
          jump_type: lookup(t.jump_types, rec.jump_type_idx, rec.jump_type_custom),
          aircraft: lookup(t.aircraft, rec.aircraft_idx),
          dropzone: lookup(t.dropzones, rec.dropzone_idx),
        };
        if (profilesOk) {
          let prof = null;
          try { prof = await this.readProfile(rec.profile_slot); } catch (e) {
            if (!(e instanceof ProtocolError)) throw e;
            result.warnings.push(`jump ${rec.jump_no}: profile read failed: ${e.message}`);
            profilesOk = false;
          }
          if (prof) {
            if (prof.jump_no !== idx) {
              // The slot's jump number must match the record index; once it does not, the ring buffer wrapped.
              result.warnings.push(`jump ${rec.jump_no}: profile slot ${rec.profile_slot} belongs to record ${prof.jump_no}; no further profiles read`);
              profilesOk = false;
            } else {
              prof.jump_no = rec.jump_no;
              jump.profile = prof;
            }
          }
        }
        result.jumps.push(jump);
      }
      result.jumps.reverse();       // oldest first
      return result;
    }
  }

  function lookup(table, idx, custom = false) {
    if (table && idx >= 0 && idx < table.length && table[idx]) return custom ? `<${table[idx]}>` : table[idx];
    return "#" + idx;
  }

  // ---------------------------------------------------------------- logbook
  const CSV_COLUMNS = ["jump_no", "date", "device_model", "device_serial", "jump_type", "aircraft", "dropzone",
    "exit_alt_ft", "deploy_alt_ft", "freefall_time_s", "canopy_time_s", "ground_alt_ft",
    "tas_3k", "tas_6k", "tas_9k", "tas_12k", "fw_version", "deleted", "profile_points", "notes"];

  const UNIT_FIELDS = { exit_alt_ft: "alt", deploy_alt_ft: "alt", ground_alt_ft: "alt",
    tas_3k: "speed", tas_6k: "speed", tas_9k: "speed", tas_12k: "speed", avg_speed: "speed" };
  const M_TO_FT = 3.28084, MS_TO_MPH = 2.23694, MS_TO_KMH = 3.6;

  /* Convert a stored value (m or m/s) to the display units; speeds are truncated as the altimeter shows them. */
  function toUnits(v, kind, units) {
    if (v == null) return v;
    if (kind === "speed") return Math.floor(v * (units === "metric" ? MS_TO_KMH : MS_TO_MPH));
    return units === "metric" ? v : Math.round(v * M_TO_FT);
  }
  const unitLabel = (kind, units) => (kind === "speed" ? (units === "metric" ? "km/h" : "mph") : units === "metric" ? "m" : "ft");
  function unitColumn(c, units) {
    const kind = UNIT_FIELDS[c];
    if (kind === "alt") return units === "metric" ? c.replace(/_ft$/, "_m") : c;
    if (kind === "speed") return `${c}_${units === "metric" ? "kmh" : "mph"}`;
    return c;
  }
  // Average freefall speed in m/s, worked out as the altimeter does: freefall distance / freefall time.
  const avgSpeed = (j) => (j.freefall_time_s > 0 && j.exit_alt_ft != null && j.deploy_alt_ft != null
    ? (j.exit_alt_ft - j.deploy_alt_ft) / j.freefall_time_s : null);

  function localIso(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function jumpToDict(jump) {
    return Object.assign(summaryToDict(jump.summary), {
      device_serial: jump.device_serial,
      device_model: jump.device_model,
      jump_type: jump.jump_type,
      aircraft: jump.aircraft,
      dropzone: jump.dropzone,
      profile: jump.profile ? { jump_no: jump.profile.jump_no, freefall_start_s: jump.profile.freefall_start_s, points: jump.profile.points } : null,
      notes: "",
      imported: localIso(),
    });
  }

  // CSV values as Python's csv module writes them (True/False, None -> empty).
  function csvCell(v) {
    if (v === null || v === undefined) return "";
    if (v === true) return "True";
    if (v === false) return "False";
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const csvRows = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

  class Logbook {
    constructor(data) {
      this.meta = (data && data.meta) || { version: 1, created: localIso() };
      this.jumps = (data && data.jumps) || [];
    }
    static key(j) { return `${j.device_serial || ""}\u0000${j.jump_no}`; }
    toJSON() { return { meta: this.meta, jumps: this.jumps }; }

    add(jumps) {
      const index = new Map(this.jumps.map((j, i) => [Logbook.key(j), i]));
      let added = 0, updated = 0;
      for (const jump of jumps) {
        const d = jump.summary ? jumpToDict(jump) : jump;
        const k = Logbook.key(d);
        if (index.has(k)) {
          const old = this.jumps[index.get(k)];
          d.notes = old.notes || "";
          if (old.profile && !d.profile) d.profile = old.profile;
          this.jumps[index.get(k)] = d;
          updated++;
        } else {
          index.set(k, this.jumps.length);
          this.jumps.push(d);
          added++;
        }
      }
      this.jumps.sort((a, b) => ((a.date || "") < (b.date || "") ? -1 : (a.date || "") > (b.date || "") ? 1 : (a.jump_no || 0) - (b.jump_no || 0)));
      return { added, updated };
    }
    find(jumpNo, serial) {
      return this.jumps.find((j) => j.jump_no === jumpNo && (serial == null || j.device_serial === serial)) || null;
    }
    /* CSV with every data point: the standard columns (same order as the Python tool), then any other
     * fields the jumps carry.  Profiles are summarised; profileCSV() exports a jump's full profile. */
    /* Running total of freefall seconds for each jump: its own freefall time plus that of every jump with a
     * lower jump number (date breaks ties).  Deleted jumps don't count. */
    freefallTotals() {
      const totals = new Map();
      let sum = 0;
      const ordered = this.jumps.slice().sort((a, b) => (a.jump_no || 0) - (b.jump_no || 0)
        || ((a.date || "") < (b.date || "") ? -1 : (a.date || "") > (b.date || "") ? 1 : 0));
      for (const j of ordered) {
        if (j.deleted) continue;
        sum += j.freefall_time_s || 0;
        totals.set(j, sum);
      }
      return totals;
    }
    toCSV(units = "imperial") {
      const extra = new Set();
      for (const j of this.jumps) for (const k of Object.keys(j)) if (k !== "profile" && !CSV_COLUMNS.includes(k)) extra.add(k);
      const cols = CSV_COLUMNS.concat([...extra], "freefall_start_s", "avg_speed", "total_freefall_s");
      const totals = this.freefallTotals();
      const value = (j, c) => (c === "profile_points" ? (j.profile ? j.profile.points.length : 0)
        : c === "freefall_start_s" ? (j.profile ? j.profile.freefall_start_s : null)
          : c === "avg_speed" ? avgSpeed(j) : c === "total_freefall_s" ? totals.get(j) : j[c]);
      return csvRows([cols.map((c) => unitColumn(c, units))].concat(this.jumps.map((j) => cols.map((c) =>
        UNIT_FIELDS[c] ? toUnits(value(j, c), UNIT_FIELDS[c], units) : value(j, c)))));
    }
    static profileCSV(jump, units = "imperial") {
      if (!jump.profile) throw new Error(`jump ${jump.jump_no} has no profile`);
      return csvRows([["time_s", units === "metric" ? "altitude_m" : "altitude_ft"]]
        .concat(jump.profile.points.map(([t, a]) => [t, toUnits(a, "alt", units)])));
    }
    stats() {
      const live = this.jumps.filter((j) => !j.deleted);
      const ff = live.reduce((a, j) => a + (j.freefall_time_s || 0), 0);
      const deploys = live.map((j) => j.deploy_alt_ft).filter(Boolean);
      return {
        jumps: live.length,
        freefall_seconds: ff,
        freefall_hms: `${Math.floor(ff / 3600)}:${pad2(Math.floor(ff / 60) % 60)}:${pad2(ff % 60)}`,
        highest_exit_ft: Math.max(0, ...live.map((j) => j.exit_alt_ft || 0)),
        lowest_deploy_ft: deploys.length ? Math.min(...deploys) : 0,
        first: live.length ? live[0].date : null,
        last: live.length ? live[live.length - 1].date : null,
        devices: [...new Set(live.map((j) => j.device_serial || ""))].sort(),
      };
    }
  }

  // Persistence: one IndexedDB record; falls back to memory when IndexedDB is unavailable.
  const store = {
    _db: null,
    _mem: null,
    async _open() {
      if (this._db) return this._db;
      this._db = await new Promise((res, rej) => {
        const req = indexedDB.open("alti2export-web", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("kv");
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      return this._db;
    },
    async load() {
      try {
        const db = await withTimeout(this._open(), 3, null);
        if (!db) return this._mem;
        return await new Promise((res, rej) => {
          const r = db.transaction("kv").objectStore("kv").get("logbook");
          r.onsuccess = () => res(r.result || null);
          r.onerror = () => rej(r.error);
        });
      } catch (e) { return this._mem; }
    },
    async save(data) {
      this._mem = data;
      try {
        const db = await withTimeout(this._open(), 3, null);
        if (!db) return false;
        await new Promise((res, rej) => {
          const tx = db.transaction("kv", "readwrite");
          tx.objectStore("kv").put(data, "logbook");
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
        return true;
      } catch (e) { return false; }
    },
  };

  // ---------------------------------------------------------------- links
  /* Byte queue with timed reads, used by SerialLink (and SimLink in alti2sim.js). */
  class ByteQueue {
    constructor() { this.buf = []; this.head = 0; this.waiters = new Set(); this.closed = false; }
    get available() { return this.buf.length - this.head; }
    push(bytes) {
      for (const b of bytes) this.buf.push(b);
      this._wake();
    }
    _wake() { const ws = [...this.waiters]; this.waiters.clear(); ws.forEach((f) => f()); }
    take(n) {
      const out = Uint8Array.from(this.buf.slice(this.head, this.head + Math.min(n, this.available)));
      this.head += out.length;
      if (this.head > 4096) { this.buf = this.buf.slice(this.head); this.head = 0; }
      return out;
    }
    clear() { this.buf = []; this.head = 0; }
    waitData(timeout) {
      if (this.available || this.closed) return Promise.resolve();
      return new Promise((res) => {
        const w = () => { clearTimeout(t); res(); };
        const t = setTimeout(() => { this.waiters.delete(w); res(); }, timeout * 1000);
        this.waiters.add(w);
      });
    }
    /* Read up to n bytes, waiting at most `timeout` seconds for each new byte (like the Python ports). */
    async read(n, timeout) {
      let out = new Uint8Array(0);
      while (out.length < n) {
        await this.waitData(timeout);
        if (!this.available) break;
        out = concat(out, this.take(n - out.length));
      }
      return out;
    }
    close() { this.closed = true; this._wake(); }
  }

  /* Web Serial port wrapper: 57600 8N1, RTS/CTS flow control. */
  class SerialLink {
    constructor(port, log) { this.port = port; this.log = log || (() => {}); this.q = new ByteQueue(); this.ctsOk = true; }
    static async open(port, log) {
      const l = new SerialLink(port, log);
      await port.open({ baudRate: 57600, dataBits: 8, stopBits: 1, parity: "none", flowControl: "hardware", bufferSize: 4096 });
      l.writer = port.writable.getWriter();
      l.loop = l._readLoop();
      return l;
    }
    async _readLoop() {
      while (this.port.readable && !this.closing) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value) this.q.push(value);
          }
        } catch (e) {
          if (!this.closing) this.log("serial read error: " + e.message);   // framing/parity errors are recoverable
        } finally {
          this.reader.releaseLock();
        }
      }
      this.q.close();
    }
    async _cts() {
      if (!this.ctsOk) return null;
      try { return (await this.port.getSignals()).clearToSend; } catch (e) { this.ctsOk = false; return null; }
    }
    async write(data, interByteDelay = 0) {
      if (this.closing) throw new ProtocolError("port closed");
      data = Uint8Array.from(data);
      if (interByteDelay <= 0) { await this.writer.write(data); return; }
      // Paced byte by byte, holding off while the adapter reports CTS low.
      for (let i = 0; i < data.length; i++) {
        const deadline = now() + 2.0;
        while ((await this._cts()) === false && now() < deadline) await sleep(0.001);
        await this.writer.write(data.subarray(i, i + 1));
        await sleep(interByteDelay);
      }
    }
    read(n, timeout) { return this.q.read(n, timeout); }
    flushInput() { this.q.clear(); }
    setDTR(on) { return this.port.setSignals({ dataTerminalReady: on }); }
    async close() {
      if (this.closing) return;
      this.closing = true;
      this.q.close();
      try { if (this.reader) await this.reader.cancel(); } catch (e) { /* ignore */ }
      try { await this.loop; } catch (e) { /* ignore */ }
      try { this.writer.releaseLock(); } catch (e) { /* ignore */ }
      try { await this.port.close(); } catch (e) { this.log("close: " + e.message); }
    }
  }

  // ---------------------------------------------------------------- exports
  const core = {
    XTEA, PRODUCT_CODES, SCHEDULES, buildKey, keyCandidates, candidatesWithOverride,
    parseSummary, encodeSummary, parseProfile, encodeProfile, parseNameTable, encodeNameTable, nameTableChecksum,
    InfoMessage, Alti2Protocol, Alti2Device, Logbook, jumpToDict, SerialLink, ByteQueue, UNIT_FIELDS, toUnits, avgSpeed,
    ProtocolError, DeviceNack, KeyRejected, toHex, hexToBytes, frame, readCommand, encodeTime, decodeTime, localIso,
    NAME_TABLES, JUMP_COUNT_ADDRESS, SUMMARY_RECORD_SIZE, PROFILE_RECORD_SIZE, PACKET_SIZE,
    CMD_READ_EEPROM, CMD_READ_INFO_MEM, CMD_READ_TIME, CMD_KEEP_ALIVE, CMD_EXIT, CMD_SET_TIME, store,
  };
  if (typeof window !== "undefined") window.Alti2Export = core;
  if (typeof document === "undefined") return;

  // ================================================================= UI
  const CSS = `
:root { --bg:#f7f7f5; --panel:#fff; --fg:#1d1d1b; --muted:#6b6b66; --line:#deded8; --accent:#2563eb; --accent-fg:#fff;
  --err:#b42318; --warn:#9a6700; --ok:#1a7f37; --code:#f0f0ec; --sel:#e8efff; --stripe:#f3f3ef; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --panel:#1f1f1d; --fg:#ecece8; --muted:#9a9a93; --line:#34342f;
  --accent:#6b9bff; --accent-fg:#0b0b0b; --err:#ff8a80; --warn:#e3b341; --ok:#56d364; --code:#262623; --sel:#24304a; --stripe:#262624; } }
* { box-sizing:border-box; } [hidden] { display:none !important; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:1200px; margin:0 auto; padding:16px; display:grid; grid-template-columns:minmax(0,1fr); gap:16px; }
a { color:var(--accent); } header h1 { font-size:20px; margin:0; } header p { margin:4px 0 0; color:var(--muted); }
section, .howto { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; min-width:0; }
section h2 { font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:0 0 10px; }
.row { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; margin-bottom:8px; }
label { display:inline-flex; gap:6px; align-items:center; color:var(--muted); }
input, select, button { font:inherit; color:var(--fg); background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:5px 8px; }
input[type=checkbox] { padding:0; }
input.short { width:90px; }
button { cursor:pointer; } button.primary { background:var(--accent); color:var(--accent-fg); border-color:var(--accent); }
button:disabled { opacity:.45; cursor:default; }
pre { background:var(--code); border-radius:6px; padding:10px; margin:0; overflow:auto; font:12px/1.4 ui-monospace,Menlo,monospace; max-height:360px; white-space:pre; }
.err { color:var(--err); } .warn { color:var(--warn); } .ok { color:var(--ok); } .muted { color:var(--muted); }
progress { width:220px; }
.tablewrap { overflow:auto; max-height:460px; border:1px solid var(--line); border-radius:6px; }
table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
th, td { padding:4px 8px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap; }
th { position:sticky; top:0; background:var(--panel); font-weight:600; }
td.n { text-align:right; } th.n { text-align:right; }
th[aria-sort] { cursor:pointer; user-select:none; } th[aria-sort]:hover, th[aria-sort]:focus-visible { color:var(--accent); outline:none; }
th .arrow { display:inline-block; width:1em; color:var(--accent); }
.colpick { margin:0 0 10px; } .colpick > summary { cursor:pointer; display:inline-block; border:1px solid var(--line); border-radius:6px; padding:5px 10px; }
.colpick[open] > summary { margin-bottom:8px; }
.colpick .cols { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(190px,100%),1fr)); gap:4px 14px; padding:10px 12px;
  border:1px solid var(--line); border-radius:6px; background:var(--bg); }
.colpick .cols label { color:var(--fg); } .colpick .row { margin:8px 0 0; }
td.notes { min-width:180px; padding:2px 6px; }
td.notes input { width:100%; min-width:160px; padding:2px 6px; border-color:transparent; background:transparent; }
td.notes input:hover { border-color:var(--line); } td.notes input:focus { border-color:var(--accent); background:var(--panel); outline:none; }
tbody tr:nth-child(even) { background:var(--stripe); }
table.sized { table-layout:fixed; } table.sized td, table.sized th { overflow:hidden; text-overflow:ellipsis; } table.sized td.notes { max-width:none; }
th .resizer { position:absolute; top:0; right:-4px; width:9px; height:100%; cursor:col-resize; z-index:1; touch-action:none; }
th .resizer::after { content:""; position:absolute; top:20%; bottom:20%; left:4px; border-left:1px solid var(--line); }
th .resizer:hover::after, th .resizer.dragging::after { border-left:2px solid var(--accent); }
.status { margin:8px 0 0; } .status:empty { display:none; } tbody tr { cursor:pointer; } tbody tr:hover, tbody tr.sel { background:var(--sel); }
tr.deleted td { color:var(--muted); text-decoration:line-through; }
svg { width:100%; height:auto; display:block; } svg text { fill:var(--muted); font-size:11px; }
.chart { position:relative; margin-top:4px; border-radius:6px; } .chart:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.chart svg { touch-action:pan-y; cursor:crosshair; }
.charttip { position:absolute; top:34px; pointer-events:none; background:var(--panel); border:1px solid var(--line); border-radius:6px;
  padding:6px 10px; box-shadow:0 4px 14px rgba(0,0,0,.15); font-size:12px; white-space:nowrap;
  display:grid; grid-template-columns:auto auto; gap:2px 10px; align-items:baseline; }
.charttip strong { font-size:13px; font-variant-numeric:tabular-nums; } .charttip span { color:var(--muted); }
svg text.marker { fill:var(--fg); font-size:11px; font-weight:600; }
.charthint { margin:8px 0 0; font-size:13px; color:var(--muted); }
.chartsel { margin:6px 0 0; font-size:13px; min-height:1.45em; } .chartsel strong { font-variant-numeric:tabular-nums; }
button.linkish { border:none; background:none; padding:0 4px; color:var(--accent); cursor:pointer; }
.stats { display:grid; grid-template-columns:auto 1fr; gap:2px 12px; margin:0; } .stats dt { color:var(--muted); } .stats dd { margin:0; }
.howto { border-color:var(--accent); }
.howto > summary { cursor:pointer; font-size:16px; font-weight:600; list-style-position:outside; }
.howto > summary span { font-size:13px; font-weight:400; color:var(--muted); margin-left:8px; }
.howto[open] > summary { margin-bottom:12px; }
.steps { list-style:none; counter-reset:step; margin:0; padding:0; display:grid; gap:12px; }
.steps > li { counter-increment:step; display:grid; grid-template-columns:28px 1fr; gap:0 10px; }
.steps > li::before { content:counter(step); grid-row:span 2; width:26px; height:26px; border-radius:50%; background:var(--accent);
  color:var(--accent-fg); display:flex; align-items:center; justify-content:center; font-weight:600; font-size:13px; }
.steps strong { display:block; } .steps p { margin:2px 0 0; color:var(--muted); grid-column:2; }
.tips { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr)); gap:12px; margin-top:14px; padding-top:14px; border-top:1px solid var(--line); }
.tips h3 { font-size:13px; margin:0 0 4px; } .tips p, .tips ul { margin:0; color:var(--muted); } .tips ul { padding-left:18px; }
.pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; border:1px solid currentColor; }
.hint { color:var(--muted); margin:0 0 10px; }
.devcard { margin-top:12px; border:1px solid var(--line); border-radius:8px; padding:12px 14px; background:var(--bg); }
.devcard[hidden] { display:none; } .devcard h3 { font-size:15px; margin:0 0 8px; } .devcard p { margin:0; }
.devcard .stats { font-size:15px; } .devcard .stats dd { font-weight:600; }
dialog.warning { max-width:560px; width:calc(100% - 32px); border:2px solid var(--err); border-radius:10px; padding:20px 22px;
  background:var(--panel); color:var(--fg); box-shadow:0 12px 40px rgba(0,0,0,.35); }
dialog.warning::backdrop { background:rgba(0,0,0,.6); }
dialog.warning h2 { color:var(--err); font-size:18px; margin:0 0 10px; } dialog.warning p { margin:0 0 16px; line-height:1.5; }
dialog.warning .actions { display:flex; flex-wrap:wrap; gap:12px; justify-content:space-between; align-items:center; }
dialog.warning .actions label { color:var(--fg); } dialog.warning button { padding:8px 16px; }
`;

  const $ = (sel) => document.querySelector(sel);
  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (v === true) e.setAttribute(k, "");
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }

  const ui = { port: null, busy: false, device: null, logbook: new Logbook(), selected: null, detectedPort: null,
    lastError: null, sort: { key: "jump_no", dir: -1 }, ffTotals: new Map(), colWidths: {} };

  // Technical messages go to the browser console; the user sees short status lines in each step.
  function log(msg, cls) {
    (cls === "err" ? console.error : cls === "warn" ? console.warn : console.log)("[alti2export] " + msg);
  }
  function say(id, msg, cls) {
    const e = $(id);
    e.className = "status " + (cls || "muted");
    e.textContent = msg || "";
  }

  /* Show progress a of b with a label; with a label but no total the bar just animates (still waiting);
   * with no label it is hidden. */
  function setProgress(label, a, b) {
    const bar = $("#progress");
    bar.hidden = !label;
    if (b) { bar.max = b; bar.value = a || 0; } else bar.removeAttribute("value");
    $("#progressLabel").textContent = label || "";
  }

  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = el("a", { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // -- port selection
  function portLabel(p) {
    const i = p.getInfo ? p.getInfo() : {};
    return i.usbVendorId != null ? `USB ${i.usbVendorId.toString(16).padStart(4, "0")}:${(i.usbProductId || 0).toString(16).padStart(4, "0")}` : "serial port";
  }
  /* When a device is unplugged, forget it if it was the selected one. */
  async function refreshPorts() {
    let ports = [];
    try { if (navigator.serial) ports = await withTimeout(navigator.serial.getPorts(), 3, []); } catch (e) { log("cannot list serial ports: " + e.message, "warn"); }
    if (ui.port && !ports.includes(ui.port)) setPort(null);
  }
  function setPort(port) {
    ui.port = port;
    if (ui.port !== ui.detectedPort) { ui.detectedPort = null; showDeviceCard(null); }
    updateButtons();
  }
  /* "Select device": pick the altimeter in Chrome's list, then detect it straight away. */
  async function choosePort() {
    if (ui.busy) return;
    if (!navigator.serial) { say("#connStatus", "This browser can’t connect to devices. Open the page in Chrome or Edge on a computer.", "err"); return; }
    say("#connStatus", "");
    try {
      setPort(await navigator.serial.requestPort());
      log("selected " + portLabel(ui.port));
    } catch (e) {
      if (e.name !== "NotFoundError") say("#connStatus", "Couldn’t open the device list: " + e.message, "err");
      return;
    }
    await cmdDetect();
  }

  function makeDevice() {
    const port = ui.port;
    return new Alti2Device(() => SerialLink.open(port, (m) => log(m, "warn")));
  }

  /* Run one device operation: connect, fn(dev), close.  Mirrors `with _open(args) as dev:` in cli.py. */
  async function withDevice(name, fn, { sendExit = true, detecting = false } = {}) {
    if (ui.busy) return;
    if (!ui.port || (!detecting && !isDetected())) return false;
    ui.busy = true; ui.lastError = null; updateButtons();
    const dev = (ui.device = makeDevice());
    log(`${name}: connecting (waits ~8 s for the device to wake up)...`);
    try {
      await dev.connect();
      log(`connected: ${dev.info.model} serial ${dev.info.serial}, firmware ${dev.info.version}, ${dev.info.total_jumps} jumps on device`, "ok");
      await fn(dev);
      return true;
    } catch (e) {
      ui.lastError = e.message;
      log(`${name} failed: ${e.message}`, "err");
      if (!(e instanceof ProtocolError)) console.error(e);
    } finally {
      try { await dev.close(sendExit); } catch (e) { /* ignore */ }
      ui.device = null; ui.busy = false; updateButtons(); setProgress();
    }
  }

  async function stop() {
    if (ui.device && ui.device.link) { ui.stopped = true; log("stopping: closing the port", "warn"); await ui.device.link.close(); }
  }

  // -- commands (cli.py equivalents)
  const establish = (dev) => dev.establishKey();

  const isDetected = () => !!ui.port && ui.detectedPort === ui.port;

  /* Runs right after "Select device": wake the device and show what its Info message says.  Required
   * before any other device command, so the user knows the right altimeter is connected and answering. */
  async function cmdDetect() {
    if (!ui.port || ui.busy) return;
    ui.detectedPort = null;
    showDeviceCard("connecting");
    await withDevice("detect", async (dev) => {
      ui.detectedPort = ui.port;
      showDeviceCard(dev.info);
    }, { detecting: true });
    if (!isDetected()) showDeviceCard("failed");
    updateButtons();
  }

  function showDeviceCard(info) {
    const card = $("#deviceCard");
    card.hidden = !info;
    if (info === "connecting") {
      card.replaceChildren(el("p", {}, el("progress"), " Waking up your altimeter… this takes about 8 seconds. Keep the cable plugged in."));
    } else if (info === "failed") {
      card.replaceChildren(el("h3", { class: "err" }, "Couldn’t detect your altimeter"),
        el("p", { class: "muted" }, "Check that the cable is plugged in firmly, that you picked the right device and that no other program is using the altimeter, "
          + "then click “Select device” again."),
        ui.lastError ? el("p", { class: "muted", style: "margin-top:6px" }, "Details: " + ui.lastError) : null);
    } else if (info) {
      const s = info.total_jump_seconds;
      const pairs = (rows) => rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]);
      card.replaceChildren(
        el("h3", { class: "ok" }, `✓ Found your ${info.model}`),
        el("dl", { class: "stats" }, pairs([
          ["Model", info.model],
          ["Serial number", info.serial],
          ["Software version", info.version],
          ["Total jumps", info.total_jumps.toLocaleString()],
          ["Total freefall time (h:mm:ss)", `${Math.floor(s / 3600)}h ${pad2(Math.floor(s / 60) % 60)}m ${pad2(s % 60)}s`],
        ])),
        el("p", { class: "muted", style: "margin-top:10px" }, "All good. Continue with step 2 to download your jumps."));
    }
  }

  async function cmdDownload() {
    if (ui.busy || !isDetected()) return;
    say("#dlStatus", "");
    setProgress("Downloading…");          // animated while the altimeter wakes up, until the first data arrives
    ui.stopped = false;
    let summary = null;
    const ok = await withDevice("download", async (dev) => {
      await establish(dev);
      log("key used: " + dev.keyLabel);
      const res = await dev.download({
        withProfiles: true, includeDeleted: false,
        progress: (stage, a, b) => (stage === "summary" ? setProgress(`Downloading… jump list ${a}/${b} bytes`, a, b)
          : stage === "jumps" ? setProgress(`Downloading… jump ${a} of ${b}`, a, b) : setProgress("Downloading…")),
      });
      res.warnings.forEach((w) => log("warning: " + w, "warn"));
      log(`tables: jump types=${JSON.stringify(res.tables.jump_types)} aircraft=${JSON.stringify(res.tables.aircraft)} dropzones=${JSON.stringify(res.tables.dropzones)}`);
      log(`downloaded ${res.jumps.length} jumps (${res.skipped.length} skipped)`, "ok");
      const r = ui.logbook.add(res.jumps);
      await saveLogbook();
      log(`logbook: ${r.added} added, ${r.updated} updated, ${ui.logbook.jumps.length} total`, "ok");
      renderLogbook();
      summary = `✓ Downloaded ${res.jumps.length} jumps from your ${dev.info.model}: ${r.added} new, ${r.updated} already in your logbook. They’re listed below.`
        + (res.warnings.length ? ` (${res.warnings.length} warning${res.warnings.length > 1 ? "s" : ""}, see the browser console.)` : "");
    });
    if (ok) say("#dlStatus", summary, "ok");
    else if (ui.stopped) say("#dlStatus", "Download stopped.", "warn");
    else say("#dlStatus", `Download failed${ui.lastError ? ": " + ui.lastError : ""}. Check the cable, click “Select device” and try again.`, "err");
  }

  // -- logbook
  async function saveLogbook() {
    if (!(await store.save(ui.logbook.toJSON()))) say("#lbStatus", "This browser won’t let the page save your logbook, so it will be lost when you close the page. Click “Export JSON” to keep a copy.", "warn");
  }

  // Logbook table columns: [field, heading, numeric].  Jump # and date are always shown; the user picks the rest.
  const LB_COLUMNS = [["jump_no", "Jump #", 1], ["date", "Date"],
    ["exit_alt_ft", "Exit", 1], ["deploy_alt_ft", "Deploy", 1], ["freefall_time_s", "Freefall (s)", 1],
    ["total_freefall_s", "Total freefall (h:mm:ss)", 1], ["canopy_time_s", "Canopy (s)", 1], ["ground_alt_ft", "Ground alt", 1], ["jump_type", "Type"], ["aircraft", "Aircraft"], ["dropzone", "Dropzone"],
    ["avg_speed", "Avg speed", 1], ["tas_3k", "Speed @ 3k ft", 1], ["tas_6k", "Speed @ 6k ft", 1], ["tas_9k", "Speed @ 9k ft", 1], ["tas_12k", "Speed @ 12k ft", 1],
    ["profile", "Chart"], ["notes", "Notes"], ["device_model", "Device"], ["device_serial", "Serial #"], ["fw_version", "Firmware"],
    ["deleted", "Deleted"], ["imported", "Imported"]];
  const LB_FIXED = ["jump_no", "date"];
  const LB_DEFAULT = ["exit_alt_ft", "deploy_alt_ft", "freefall_time_s", "total_freefall_s", "notes"];
  const LB_COLS_KEY = "alti2export.columns";
  const UNITS_KEY = "alti2export.units";

  const heading = (k, h) => (UNIT_FIELDS[k] ? `${h} (${unitLabel(UNIT_FIELDS[k], ui.units)})` : h);

  function loadUnits() {
    try { return localStorage.getItem(UNITS_KEY) === "metric" ? "metric" : "imperial"; } catch (e) { return "imperial"; }
  }
  function setUnits(units) {
    ui.units = units;
    try { localStorage.setItem(UNITS_KEY, units); } catch (e) { /* ignore */ }
    renderColumnPicker();
    renderLogbook();
  }

  function loadColumns() {
    try {
      const saved = JSON.parse(localStorage.getItem(LB_COLS_KEY));
      if (Array.isArray(saved)) return new Set(saved.filter((k) => LB_COLUMNS.some(([c]) => c === k)));
    } catch (e) { /* storage blocked or bad value */ }
    return new Set(LB_DEFAULT);
  }
  // Column widths the user dragged, in px by field; kept per browser.
  const LB_WIDTHS_KEY = "alti2export.columnWidths";
  function loadWidths() {
    try { const w = JSON.parse(localStorage.getItem(LB_WIDTHS_KEY)); if (w && typeof w === "object") return w; } catch (e) { /* ignore */ }
    return {};
  }
  function saveWidths() {
    try { localStorage.setItem(LB_WIDTHS_KEY, JSON.stringify(ui.colWidths)); } catch (e) { /* ignore */ }
  }

  /* Give the table fixed column widths: saved ones where the user dragged, the natural width elsewhere.
   * Fixed layout lets a column shrink below its content (cells are cut off with "…"). */
  function freezeWidths(table) {
    const ths = [...table.querySelectorAll("thead th")];
    const widths = ths.map((th) => ui.colWidths[th.dataset.key] || th.offsetWidth);
    ths.forEach((th, i) => { th.style.width = widths[i] + "px"; });
    table.style.width = widths.reduce((a, w) => a + w, 0) + "px";
    table.classList.add("sized");
  }

  /* Drag handle on a header's right edge; double-click puts the column back to its natural width. */
  function resizer(key) {
    const h = el("span", { class: "resizer", "aria-hidden": "true", title: "Drag to resize, double-click to reset",
      onclick: (e) => e.stopPropagation(),
      ondblclick: (e) => { e.stopPropagation(); delete ui.colWidths[key]; saveWidths(); renderLogbook(); } });
    h.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const th = h.parentElement, table = th.closest("table");
      if (!table.classList.contains("sized")) freezeWidths(table);
      const startX = e.clientX, startW = th.offsetWidth, startT = table.offsetWidth;
      try { h.setPointerCapture(e.pointerId); } catch (x) { /* synthetic event */ }
      h.classList.add("dragging");
      const move = (ev) => {
        const w = Math.max(40, startW + ev.clientX - startX);
        th.style.width = w + "px";
        table.style.width = startT + w - startW + "px";
        ui.colWidths[key] = w;
      };
      const up = () => {
        h.removeEventListener("pointermove", move);
        h.classList.remove("dragging");
        saveWidths();
      };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up, { once: true });
      h.addEventListener("pointercancel", up, { once: true });
    });
    return h;
  }

  function setColumns(keys) {
    ui.cols = new Set(keys);
    try { localStorage.setItem(LB_COLS_KEY, JSON.stringify([...ui.cols])); } catch (e) { /* ignore */ }
    if (!LB_FIXED.includes(ui.sort.key) && !ui.cols.has(ui.sort.key)) ui.sort = { key: "jump_no", dir: -1 };   // sorted column was hidden
    renderColumnPicker();
    renderLogbook();
  }
  const visibleColumns = () => LB_COLUMNS.filter(([k]) => LB_FIXED.includes(k) || ui.cols.has(k));

  function renderColumnPicker() {
    const picker = $("#colPicker");
    const choosable = LB_COLUMNS.filter(([k]) => !LB_FIXED.includes(k));
    picker.querySelector("summary").textContent = `Columns: ${ui.cols.size} of ${choosable.length} shown`;
    picker.querySelector(".cols").replaceChildren(...choosable.map(([k, h]) =>
      el("label", {}, el("input", { type: "checkbox", checked: ui.cols.has(k),
        onchange: (e) => { const next = new Set(ui.cols); e.target.checked ? next.add(k) : next.delete(k); setColumns(next); } }), heading(k, h))));
  }

  function cellText(j, k) {
    if (k === "profile") return j.profile ? "yes" : "no";
    if (k === "deleted") return j.deleted ? "yes" : "";
    if (k === "date" || k === "imported") return (j[k] || "").replace("T", " ");
    if (/^tas_/.test(k) && !j[k]) return "–";      // 0 = the jump never passed that altitude
    if (k === "total_freefall_s") return ui.ffTotals.has(j) ? hms(ui.ffTotals.get(j)) : "";
    if (UNIT_FIELDS[k]) return toUnits(sortValue(j, k), UNIT_FIELDS[k], ui.units);
    return j[k];
  }

  const sortValue = (j, key) => (key === "profile" ? (j.profile ? 1 : 0) : key === "deleted" ? (j.deleted ? 1 : 0)
    : key === "avg_speed" ? avgSpeed(j) : key === "total_freefall_s" ? ui.ffTotals.get(j) : j[key]);

  /* Compare two jumps on the current sort column; empty values always go last, ties fall back to jump number. */
  function compareJumps(a, b) {
    const { key, dir } = ui.sort;
    const va = sortValue(a, key), vb = sortValue(b, key);
    const ea = va == null || va === "", eb = vb == null || vb === "";
    if (ea !== eb) return ea ? 1 : -1;
    let c = 0;
    if (!ea) c = typeof va === "number" && typeof vb === "number" ? va - vb
      : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" });
    return (c || (a.jump_no || 0) - (b.jump_no || 0)) * dir;
  }

  function sortBy(key, numeric) {
    if (ui.sort.key === key) ui.sort.dir = -ui.sort.dir;
    else ui.sort = { key, dir: numeric || key === "date" || key === "imported" ? -1 : 1 };    // numbers and dates: biggest/newest first
    renderLogbook();
    const th = document.querySelector(`#jumps th[data-key="${key}"]`);
    if (th) th.focus();
  }

  function renderLogbook() {
    const lb = ui.logbook;
    ui.ffTotals = lb.freefallTotals();
    const rows = lb.jumps.slice().sort(compareJumps);
    const cols = visibleColumns();
    const tbody = el("tbody");
    for (const j of rows) {
      const tr = el("tr", { class: (j.deleted ? "deleted " : "") + (ui.selected === j ? "sel" : ""), onclick: () => { ui.selected = j; renderLogbook(); } },
        cols.map(([k, , n]) => k === "notes" ? el("td", { class: "notes" }, notesInput(j))
          : el("td", { class: n ? "n" : "" }, cellText(j, k))));
      tbody.append(tr);
    }
    const head = cols.map(([k, h0, n]) => {
      const h = heading(k, h0), active = ui.sort.key === k;
      return el("th", {
        class: n ? "n" : "", "data-key": k, tabindex: 0, title: `Sort by ${h.toLowerCase()}`,
        "aria-sort": active ? (ui.sort.dir > 0 ? "ascending" : "descending") : "none",
        onclick: () => sortBy(k, n),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sortBy(k, n); } },
      }, h, el("span", { class: "arrow", "aria-hidden": "true" }, active ? (ui.sort.dir > 0 ? "▲" : "▼") : ""), resizer(k));
    });
    const table = el("table", {}, el("thead", {}, el("tr", {}, head)), tbody);
    $("#jumps").replaceChildren(table);
    if (cols.some(([k]) => ui.colWidths[k])) freezeWidths(table);
    $("#lbCount").textContent = lb.jumps.length ? `${lb.jumps.length} jump${lb.jumps.length === 1 ? "" : "s"} in logbook`
      : "No jumps yet. Connect your altimeter and click “Download jumps”.";
    renderJump();
  }

  /* Editable notes cell: saved when the box loses focus or on Enter; Esc puts the old text back.
   * Clicks and keys stay in the box so they don't select the row or sort the table. */
  function notesInput(j) {
    const box = el("input", { type: "text", value: j.notes || "", placeholder: "Add a note", "aria-label": `Notes for jump ${j.jump_no}`,
      title: j.notes || "Add a note", onclick: (e) => e.stopPropagation(), onpointerdown: (e) => e.stopPropagation() });
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") box.blur();
      if (e.key === "Escape") { box.value = j.notes || ""; box.blur(); }
    });
    box.addEventListener("blur", async () => {
      if (box.value === (j.notes || "")) return;
      j.notes = box.value;
      box.title = j.notes || "Add a note";
      await saveLogbook();
      say("#lbStatus", `✓ Notes saved for jump ${j.jump_no}.`, "ok");
      if (ui.selected === j) renderJump();       // keep the details box in step
    });
    return box;
  }

  function renderJump() {
    const j = ui.selected;
    const box = $("#jumpDetail");
    if (!j || !ui.logbook.jumps.includes(j)) { box.replaceChildren(el("p", { class: "muted" }, "Click a jump in the table to see its altitude chart and add notes.")); return; }
    const notes = el("input", { value: j.notes || "", placeholder: "notes", style: "flex:1;min-width:200px" });
    box.replaceChildren(
      el("div", { class: "row" },
        el("strong", {}, `Jump ${j.jump_no}`), el("span", { class: "muted" }, `${j.device_model} ${j.device_serial}`),
        notes,
        el("button", { onclick: async () => { j.notes = notes.value; await saveLogbook(); renderLogbook(); say("#lbStatus", `✓ Notes saved for jump ${j.jump_no}.`, "ok"); } }, "Save notes"),
        el("button", { disabled: !j.profile, onclick: () => download(`profile-${j.jump_no}.csv`, Logbook.profileCSV(j, ui.units), "text/csv") }, "Export profile CSV"),
        el("button", { onclick: () => download(`jump-${j.jump_no}.json`, JSON.stringify(j, null, 1), "application/json") }, "Export JSON")),
      j.profile ? profileChart(j) : el("p", { class: "muted" }, "No altitude chart stored for this jump."));
  }

  function profileChart(j) {
    const pts = j.profile.points.map(([t, a]) => [t, toUnits(a, "alt", ui.units)]);
    const W = 720, H = 270, L = 52, R = 12, T = 24, B = 30;
    const ts = pts.map((p) => p[0]), as = pts.map((p) => p[1]);
    const t0 = Math.min(...ts), t1 = Math.max(...ts), a0 = Math.min(0, ...as), a1 = Math.max(...as) || 1;
    const x = (t) => L + ((t - t0) / ((t1 - t0) || 1)) * (W - L - R);
    const y = (a) => T + (1 - (a - a0) / ((a1 - a0) || 1)) * (H - T - B);
    const ns = "http://www.w3.org/2000/svg";
    const s = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; };
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Altitude profile of jump ${j.jump_no}` });
    const grid = "stroke:var(--line);stroke-width:1";
    const step = ui.units === "metric" ? (a1 > 2500 ? 500 : a1 > 1000 ? 250 : 100) : (a1 > 8000 ? 2000 : a1 > 3000 ? 1000 : 500);
    for (let a = Math.ceil(a0 / step) * step; a <= a1; a += step) {
      svg.append(s("line", { x1: L, x2: W - R, y1: y(a), y2: y(a), style: grid }));
      svg.append(s("text", { x: L - 6, y: y(a) + 4, "text-anchor": "end" }, a));
    }
    const tstep = (t1 - t0) > 200 ? 60 : (t1 - t0) > 60 ? 20 : 10;
    for (let t = Math.ceil(t0 / tstep) * tstep; t <= t1; t += tstep) {
      svg.append(s("line", { x1: x(t), x2: x(t), y1: T, y2: H - B, style: grid }));
      svg.append(s("text", { x: x(t), y: H - B + 16, "text-anchor": "middle" }, `${t}s`));
    }
    // Exit (freefall start, t = 0) and canopy (deployment, after the freefall time) markers, labelled above the plot.
    const marker = (t, label) => {
      if (t == null || t < t0 || t > t1) return;
      svg.append(s("line", { x1: x(t), x2: x(t), y1: T, y2: H - B, style: "stroke:var(--fg);stroke-width:1;stroke-dasharray:4 3;opacity:.55" }));
      svg.append(s("text", { x: x(t), y: T - 7, "text-anchor": "middle", class: "marker" }, label));
    };
    marker(0, "Exit");
    marker(j.freefall_time_s, "Canopy");
    svg.append(s("polyline", { points: pts.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" "),
      fill: "none", style: "stroke:var(--accent);stroke-width:2;stroke-linejoin:round" }));
    svg.append(s("text", { x: L, y: T + 2, dy: "0.7em", dx: 6 }, unitLabel("alt", ui.units)));
    return withHover(j, svg, pts, { x, y, t0, t1, W, L, R, T, H, B, s });
  }

  /* Interaction for the altitude chart, like a stock chart: a crosshair snaps to the nearest recorded point
   * and a readout shows the values there.  Dragging across the chart selects a range and shows the
   * average speed over it.  Keyboard: arrows move, Shift+arrows select, Esc clears. */
  function withHover(j, svg, pts, { x, y, t0, t1, W, L, R, T, H, B, s }) {
    const raw = j.profile.points;                  // stored values (m) for speeds
    const ff = j.freefall_time_s;
    const band = s("rect", { y: T, height: H - T - B, style: "fill:var(--accent);opacity:.12", visibility: "hidden" });
    svg.insertBefore(band, svg.querySelector("polyline"));
    const cross = s("line", { y1: T, y2: H - B, style: "stroke:var(--muted);stroke-width:1", visibility: "hidden" });
    const dot = s("circle", { r: 4.5, style: "fill:var(--accent);stroke:var(--panel);stroke-width:2", visibility: "hidden" });
    svg.append(cross, dot);
    const tip = el("div", { class: "charttip", hidden: true });
    const readout = el("span", { "aria-live": "polite" });
    const clearBtn = el("button", { class: "linkish", hidden: true, title: "Clear the selection", onclick: () => select(null) }, "✕ Clear");
    const wrap = el("div", { class: "chart", tabindex: 0,
      "aria-label": `Altitude chart of jump ${j.jump_no}. Left and right arrow keys read the values; hold Shift to select a range.` },
      svg, tip, el("p", { class: "chartsel" }, readout, " ", clearBtn));
    let current = null, sel = null, drag = null;
    const speedText = (ms) => `${toUnits(ms, "speed", ui.units)} ${unitLabel("speed", ui.units)}`;
    const altText = (a) => `${a.toLocaleString()} ${unitLabel("alt", ui.units)}`;

    const descentRate = (i) => {                   // m/s from the neighbouring points; climbing counts as 0
      const a = raw[Math.max(0, i - 1)], b = raw[Math.min(raw.length - 1, i + 1)];
      return b[0] > a[0] ? Math.max(0, (a[1] - b[1]) / (b[0] - a[0])) : 0;
    };
    const phase = (t) => (t < 0 ? "Before exit" : ff != null && t > ff ? "Under canopy" : "Freefall");

    function show(i) {
      current = i;
      const [t, alt] = pts[i], px = x(t), py = y(alt);
      cross.setAttribute("x1", px); cross.setAttribute("x2", px);
      dot.setAttribute("cx", px); dot.setAttribute("cy", py);
      cross.setAttribute("visibility", "visible"); dot.setAttribute("visibility", "visible");
      const rows = [
        [altText(alt), "altitude"],
        [`${t >= 0 ? "+" : "−"}${Math.abs(t).toFixed(1)} s`, "from exit"],
        [speedText(descentRate(i)), "descent rate"],
        [phase(t), ""],
      ];
      tip.replaceChildren(...rows.flatMap(([v, k]) => [el("strong", {}, v), el("span", {}, k)]));
      tip.hidden = false;
      const scale = svg.clientWidth / W;
      let left = px * scale + 14;
      if (left + tip.offsetWidth > wrap.clientWidth) left = px * scale - 14 - tip.offsetWidth;
      tip.style.left = Math.max(0, left) + "px";
    }
    function hide() {
      current = null;
      tip.hidden = true;
      cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden");
    }

    /* Select the points a..b (indices, either order), or clear with null. */
    function select(range) {
      sel = range && range[0] !== range[1] ? [Math.min(...range), Math.max(...range)] : null;
      band.setAttribute("visibility", sel ? "visible" : "hidden");
      clearBtn.hidden = !sel;
      if (!sel) { readout.textContent = ""; return; }
      const [i, k] = sel, xa = x(pts[i][0]), xb = x(pts[k][0]);
      const when = (n) => { const m = snaps.find((m) => m.i === n); return `${m ? m.name + " (" : ""}${pts[n][0].toFixed(1)} s${m ? ")" : ""}`; };
      band.setAttribute("x", xa); band.setAttribute("width", xb - xa);
      const dt = raw[k][0] - raw[i][0], drop = raw[i][1] - raw[k][1];
      const avg = dt > 0 ? drop / dt : 0;
      readout.className = "";
      readout.replaceChildren(
        el("strong", {}, avg >= 0 ? speedText(avg) : `climbing ${speedText(-avg)}`), " average speed · ",
        `${when(i)} to ${when(k)}, ${dt.toFixed(1)} s · `,
        `${altText(pts[i][1])} to ${altText(pts[k][1])}, ${drop >= 0 ? "lost" : "gained"} ${altText(Math.abs(pts[i][1] - pts[k][1]))}`);
    }

    const nearestTo = (t) => pts.reduce((best, p, i) => (Math.abs(p[0] - t) < Math.abs(pts[best][0] - t) ? i : best), 0);
    // Exit and canopy marker points that a selection snaps to.
    const snaps = [[0, "exit"], [ff, "canopy"]].filter(([t]) => t != null && t >= t0 && t <= t1)
      .map(([t, name]) => ({ t, name, i: nearestTo(t) }));
    const SNAP_PX = 12;

    /* Nearest recorded point to the pointer.  With snap, a pointer within SNAP_PX of the exit or canopy
     * line picks that marker's point; elsewhere the selection is free. */
    function nearest(clientX, snap = false) {
      const r = svg.getBoundingClientRect(), k = r.width / W;
      if (snap) {
        const hit = snaps.find((m) => Math.abs(clientX - (r.left + x(m.t) * k)) <= SNAP_PX);
        if (hit) return hit.i;
      }
      return nearestTo(t0 + (((clientX - r.left) / k - L) / (W - L - R)) * (t1 - t0));
    }

    svg.addEventListener("pointerdown", (e) => {
      const i = nearest(e.clientX, true);
      drag = { start: i, x: e.clientX };
      try { svg.setPointerCapture(e.pointerId); } catch (x) { /* synthetic event */ }
      show(i);
    });
    svg.addEventListener("pointermove", (e) => {
      const i = nearest(e.clientX, !!drag);
      show(i);
      if (drag && Math.abs(e.clientX - drag.x) > 4) select([drag.start, i]);
    });
    const endDrag = (e) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) <= 4) select(null);     // a click (no drag) clears the selection
      drag = null;
    };
    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", () => { drag = null; });
    svg.addEventListener("pointerleave", () => { if (!drag && document.activeElement !== wrap) hide(); });
    wrap.addEventListener("focus", () => show(current == null ? 0 : current));
    wrap.addEventListener("blur", hide);
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { select(null); return; }
      const i = current == null ? 0 : current;
      let next = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: pts.length - 1 }[e.key];
      if (next == null) return;
      e.preventDefault();
      next = Math.min(pts.length - 1, Math.max(0, next));
      if (e.shiftKey) {
        // extend from the end of the selection that isn't moving
        const anchor = sel ? (sel[0] === i ? sel[1] : sel[0]) : i;
        select([anchor, next]);
      }
      show(next);
    });
    select(null);
    return el("div", {},
      el("p", { class: "charthint" }, "Tip: hover to read the altitude and speed. Click and drag across the chart to measure the average speed "
        + "between two points; the ends snap to the Exit and Canopy lines."),
      wrap);
  }

  async function importJSON(file) {
    try {
      const data = JSON.parse(await file.text());
      const jumps = Array.isArray(data) ? data : data.jumps;     // logbook.json or a `download --json` file
      if (!Array.isArray(jumps)) throw new Error("no jumps array found");
      const r = ui.logbook.add(jumps);
      await saveLogbook();
      say("#lbStatus", `✓ Imported ${file.name}: ${r.added} new jumps, ${r.updated} updated.`, "ok");
      renderLogbook();
    } catch (e) { say("#lbStatus", `Couldn’t import ${file.name}: ${e.message}`, "err"); }
  }

  function updateButtons() {
    document.querySelectorAll("button[data-dev]").forEach((b) => { b.disabled = ui.busy || !isDetected(); });
    $("#selectBtn").disabled = ui.busy;
    $("#stopBtn").disabled = !ui.busy;
  }

  // -- layout
  function howTo() {
    const KEY = "alti2export.howtoOpen";
    let open = true;
    try { open = localStorage.getItem(KEY) !== "0"; } catch (e) { /* storage blocked */ }
    const serialOk = !!navigator.serial;
    const step = (title, text) => el("li", {}, el("strong", {}, title), el("p", {}, ...[].concat(text)));
    return el("details", { class: "howto", open, ontoggle: (e) => { try { localStorage.setItem(KEY, e.target.open ? "1" : "0"); } catch (x) { /* ignore */ } } },
      el("summary", {}, "How to use this page", el("span", {}, "takes about a minute, click to hide")),
      el("ol", { class: "steps" },
        step("Open this page in Google Chrome or Microsoft Edge on a computer.",
          "Safari, Firefox and phones can't connect to USB devices from a web page."),
        step("Plug your altimeter into the computer with a USB data cable.",
          "Supported models: Atlas, Atlas 2, Neptune II, Neptune III / IIIA and MA-12."),
        step("Click “Select device” and pick your altimeter in the list that pops up.",
          "It usually shows up as a USB serial device. Example cu.usbserial.A2QDB3BF or tty.usbserial.A2QDB3BF. "
          + "The page then connects to it: after about 8 seconds your altimeter’s model, serial number, software version and total jump count appear, and the download button unlocks."),
        step("Click the blue “Download jumps” button.",
          "Connecting takes about 8 seconds while the altimeter wakes up. A progress bar then shows the download. Keep the cable plugged in until a message under the button says it’s done."),
        step("Look through your jumps in the Logbook section below.",
          "Use “Units” to switch between feet/mph and meters/km/h, “Columns” to choose which data points the table shows, click a column heading to sort, and click any jump to see its altitude chart and add notes. Use “Export CSV” to open the logbook in Excel, Numbers or Google Sheets.")),
      el("div", { class: "tips" },
        el("div", {}, el("h3", {}, "Already have a logbook file?"),
          el("p", {}, "Click “Import JSON…” in the Logbook section to load a logbook.json saved from this page or the alti2export command-line tool.")),
        el("div", {}, el("h3", {}, "Where is my data kept?"),
          el("p", {}, "Only in this browser, on this computer. Nothing is uploaded. Clearing your browser data erases the logbook, so click “Export JSON” now and then to keep a backup. “Import JSON…” puts it back.")),
        el("div", {}, el("h3", {}, "Something not working?"),
          el("ul", {},
            el("li", {}, "Port missing from the list: unplug the cable, plug it back in and try again."),
            el("li", {}, "Close any other program that might be using the altimeter, such as Alti-2’s own software."),
            el("li", {}, "Download fails: read the message under the Download button, then click “Select device” and try again.")))));
  }

  function build() {
    document.head.append(el("style", {}, CSS));
    if (!document.title) document.title = "Alti-2 Data Exporter";
    const dev = (label, fn, primary) => el("button", { "data-dev": true, class: primary ? "primary" : "", onclick: fn }, label);
    document.body.append(el("main", {},
      el("header", {}, el("h1", {}, "Alti-2 Data Exporter"),
        el("p", {}, "Download your jump log from an Alti-2 altimeter, browse it, and export it to a spreadsheet."),
        el("p", {}, "Is your altimeter not supported? Questions, comments or concerns? Email ", el("a", { href: "mailto:staff@skydiving.is" }, "staff@skydiving.is"), ".")),
      howTo(),
      el("section", {}, el("h2", {}, "1 · Connect your altimeter"),
        el("div", { class: "row" },
          el("button", { id: "selectBtn", class: "primary", onclick: choosePort, title: "Pick your altimeter and connect to it" }, "Select device")),
        el("p", { class: "hint", style: "margin:0" }, "Plug in your altimeter, click “Select device” and pick it from the list. "
          + "It usually shows up as a USB serial device, for example cu.usbserial.A2QDB3BF or tty.usbserial.A2QDB3BF. "
          + "The page connects to it straight away, and the download button in step 2 unlocks once your altimeter has been found."),
        el("p", { id: "connStatus", class: "status", "aria-live": "polite" }),
        el("div", { id: "deviceCard", class: "devcard", hidden: true, "aria-live": "polite" })),
      el("section", {}, el("h2", {}, "2 · Download your jumps"),
        el("div", { class: "row", style: "margin:0" }, dev("Download jumps", cmdDownload, true),
          el("button", { id: "stopBtn", disabled: true, onclick: stop }, "Stop"),
          el("progress", { id: "progress", hidden: true }), el("span", { id: "progressLabel", class: "muted" })),
        el("p", { id: "dlStatus", class: "status", "aria-live": "polite" })),
      el("section", {}, el("h2", {}, "3 · Your logbook"),
        el("div", { class: "row" },
          el("span", { id: "lbCount", class: "muted" }),
          el("label", { title: "Units for altitudes and speeds in the table, chart and CSV export" }, "Units",
            el("select", { id: "units", onchange: (e) => setUnits(e.target.value) },
              el("option", { value: "imperial", selected: ui.units === "imperial" }, "Imperial (ft, mph)"),
              el("option", { value: "metric", selected: ui.units === "metric" }, "Metric (m, km/h)"))),
          el("button", { title: "Every data point for every jump, whatever columns are shown", onclick: () => download("logbook.csv", ui.logbook.toCSV(ui.units), "text/csv") }, "Export CSV"),
          el("button", { onclick: () => download("logbook.json", JSON.stringify(ui.logbook.toJSON(), null, 1), "application/json") }, "Export JSON"),
          el("label", { class: "", title: "Import a alti2export logbook.json or a download --json file" },
            el("button", { onclick: () => $("#importFile").click() }, "Import JSON…"),
            el("input", { id: "importFile", type: "file", accept: ".json,application/json", hidden: true,
              onchange: (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ""; } })),
          el("button", { onclick: async () => { if (confirm("Delete all jumps from the browser logbook?")) { ui.logbook = new Logbook(); ui.selected = null; await saveLogbook(); renderLogbook(); say("#lbStatus", "Logbook cleared."); } } }, "Clear")),
        el("p", { id: "lbStatus", class: "status", style: "margin:0 0 8px", "aria-live": "polite" }),
        el("details", { id: "colPicker", class: "colpick" }, el("summary", {}, "Columns"),
          el("div", { class: "cols" }),
          el("div", { class: "row" },
            el("button", { onclick: () => setColumns(LB_DEFAULT) }, "Reset to default"),
            el("button", { onclick: () => { ui.colWidths = {}; saveWidths(); renderLogbook(); } }, "Reset column widths"),
            el("button", { onclick: () => setColumns(LB_COLUMNS.map(([k]) => k).filter((k) => !LB_FIXED.includes(k))) }, "Show all"),
            el("span", { class: "muted" }, "Export CSV always includes every data point."))),
        el("div", { class: "tablewrap", id: "jumps" }),
        el("div", { id: "jumpDetail", style: "margin-top:12px" }))));

    if (!navigator.serial) log("Web Serial is not available here (needs Chrome/Edge or https).", "warn");
    else {
      navigator.serial.addEventListener("disconnect", refreshPorts);
    }
  }

  // "Do not show again" on the disclaimer is remembered in a cookie for a year.
  const WARNING_COOKIE = "alti2export_warning_accepted";
  const warningAccepted = () => document.cookie.split("; ").includes(WARNING_COOKIE + "=1");
  function rememberWarning() {
    document.cookie = `${WARNING_COOKIE}=1; max-age=${365 * 24 * 3600}; path=/; SameSite=Lax`;
  }

  /* Disclaimer shown on every visit until "Do not show again" is ticked; the page can't be used until it is confirmed. */
  function showWarning() {
    if (warningAccepted()) return;
    const again = el("input", { type: "checkbox", id: "warnAgain" });
    const d = el("dialog", { class: "warning", "aria-labelledby": "warnTitle", "aria-describedby": "warnText" },
      el("h2", { id: "warnTitle" }, "⚠ WARNING"),
      el("p", { id: "warnText" }, "Reading data is normally safe, but you use this software and the information it provides entirely at your own risk. "
        + "The software is provided “as is”, without warranty of any kind. The author is not liable for any damage, malfunction, injury or other issues resulting from its use. "
        + "Always check that your altimeter works correctly before you jump."),
      el("p", {}, "This software is made by a private developer and is not affiliated with, endorsed by or associated with Alti-2 Technologies."),
      el("div", { class: "actions" },
        el("label", {}, again, "Do not show again"),
        el("button", { class: "primary", autofocus: true, onclick: () => { if (again.checked) rememberWarning(); d.close(); d.remove(); } },
          "I understand and accept")));
    d.addEventListener("cancel", (e) => e.preventDefault());     // Escape must not dismiss it
    document.body.append(d);
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  }

  async function init() {
    ui.cols = loadColumns();
    ui.units = loadUnits();
    ui.colWidths = loadWidths();
    build();
    renderColumnPicker();
    showWarning();
    updateButtons();
    const saved = await store.load();
    if (saved) ui.logbook = new Logbook(saved);
    renderLogbook();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
