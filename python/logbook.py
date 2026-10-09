"""A simple JSON logbook with CSV export."""

import csv
import json
import os
from datetime import datetime
from typing import Dict, List, Optional

from .records import summary_to_dict
from .units import UNIT_FIELDS, avg_speed, hms, to_units, unit_column

DEFAULT_PATH = os.path.join(os.path.expanduser("~"), ".alti2export", "logbook.json")

CSV_COLUMNS = ["jump_no", "date", "device_model", "device_serial", "jump_type", "aircraft", "dropzone",
               "exit_alt_ft", "deploy_alt_ft", "freefall_time_s", "canopy_time_s", "ground_alt_ft",
               "tas_3k", "tas_6k", "tas_9k", "tas_12k", "fw_version", "deleted", "profile_points", "notes"]


def jump_to_dict(jump) -> dict:
    d = summary_to_dict(jump.summary)
    d.update({
        "device_serial": jump.device_serial,
        "device_model": jump.device_model,
        "jump_type": jump.jump_type,
        "aircraft": jump.aircraft,
        "dropzone": jump.dropzone,
        "profile": jump.profile.as_dict() if jump.profile else None,
        "notes": "",
        "imported": datetime.now().isoformat(timespec="seconds"),
    })
    return d


class Logbook:
    def __init__(self, path: Optional[str] = None):
        self.path = path or DEFAULT_PATH
        self.jumps: List[dict] = []
        self.meta = {"version": 1, "created": datetime.now().isoformat(timespec="seconds")}

    @classmethod
    def load(cls, path: Optional[str] = None) -> "Logbook":
        lb = cls(path)
        if os.path.exists(lb.path):
            with open(lb.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            lb.meta = data.get("meta", lb.meta)
            lb.jumps = data.get("jumps", [])
        return lb

    def save(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.path)) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"meta": self.meta, "jumps": self.jumps}, f, indent=1)
        os.replace(tmp, self.path)

    @staticmethod
    def key(j: dict):
        return (j.get("device_serial", ""), j.get("jump_no"))

    def add(self, jumps) -> Dict[str, int]:
        index = {self.key(j): i for i, j in enumerate(self.jumps)}
        added = updated = 0
        for jump in jumps:
            d = jump if isinstance(jump, dict) else jump_to_dict(jump)
            k = self.key(d)
            if k in index:
                old = self.jumps[index[k]]
                d["notes"] = old.get("notes", "")
                if old.get("profile") and not d.get("profile"):
                    d["profile"] = old["profile"]
                self.jumps[index[k]] = d
                updated += 1
            else:
                index[k] = len(self.jumps)
                self.jumps.append(d)
                added += 1
        self.jumps.sort(key=lambda j: (j.get("date") or "", j.get("jump_no") or 0))
        return {"added": added, "updated": updated}

    def find(self, jump_no: int, serial: Optional[str] = None) -> Optional[dict]:
        for j in self.jumps:
            if j.get("jump_no") == jump_no and (serial is None or j.get("device_serial") == serial):
                return j
        return None

    @staticmethod
    def freefall_totals(jumps: List[dict]) -> Dict[int, int]:
        """Running total of freefall seconds for each jump (keyed by id(jump)): its own freefall time plus
        that of every jump with a lower jump number (date breaks ties).  Deleted jumps don't count."""
        totals, total = {}, 0
        for j in sorted(jumps, key=lambda j: (j.get("jump_no") or 0, j.get("date") or "")):
            if j.get("deleted"):
                continue
            total += j.get("freefall_time_s") or 0
            totals[id(j)] = total
        return totals

    def export_csv(self, path: str, units: str = "imperial"):
        """CSV with every data point: the standard columns, then any other fields the jumps carry, the
        profile's freefall start, the calculated average speed and the running freefall total.  Altitudes
        and speeds are converted to `units` and their column names say which (exit_alt_ft / exit_alt_m,
        tas_3k_mph / tas_3k_kmh)."""
        extra = []
        for j in self.jumps:
            extra += [k for k in j if k != "profile" and k not in CSV_COLUMNS and k not in extra]
        cols = CSV_COLUMNS + extra + ["freefall_start_s", "avg_speed", "total_freefall_s"]
        totals = self.freefall_totals(self.jumps)

        def value(j, c):
            if c == "profile_points":
                return len(j["profile"]["points"]) if j.get("profile") else 0
            if c == "freefall_start_s":
                return j["profile"].get("freefall_start_s") if j.get("profile") else None
            if c == "total_freefall_s":
                return totals.get(id(j))
            v = avg_speed(j) if c == "avg_speed" else j.get(c)
            return to_units(v, UNIT_FIELDS[c], units) if c in UNIT_FIELDS else v

        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow([unit_column(c, units) for c in cols])
            for j in self.jumps:
                w.writerow(["" if v is None else v for v in (value(j, c) for c in cols)])

    @staticmethod
    def export_profile_csv(jump: dict, path: str, units: str = "imperial"):
        prof = jump.get("profile")
        if not prof:
            raise ValueError("jump %s has no profile" % jump.get("jump_no"))
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["time_s", "altitude_m" if units == "metric" else "altitude_ft"])
            for t, a in prof["points"]:
                w.writerow([t, to_units(a, "alt", units)])

    def stats(self, units: str = "imperial") -> dict:
        live = [j for j in self.jumps if not j.get("deleted")]
        ff = sum(j.get("freefall_time_s") or 0 for j in live)
        unit = "m" if units == "metric" else "ft"
        return {
            "jumps": len(live),
            "freefall_seconds": ff,
            "freefall_hms": hms(ff),
            "highest_exit_" + unit: to_units(max([j.get("exit_alt_ft") or 0 for j in live] or [0]), "alt", units),
            "lowest_deploy_" + unit: to_units(min([j.get("deploy_alt_ft") for j in live if j.get("deploy_alt_ft")] or [0]),
                                              "alt", units),
            "first": live[0]["date"] if live else None,
            "last": live[-1]["date"] if live else None,
            "devices": sorted({j.get("device_serial", "") for j in live}),
        }
