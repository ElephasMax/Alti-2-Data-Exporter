"""Display units for logbook values.

The device stores altitudes in meters and the ``tas_*`` speeds in m/s (both checked against the
altimeter's own display), although the altitude fields are named ``*_ft``; the names are kept so
logbook files stay compatible with the web version.  Profile altitudes are assumed to be meters as
well.  Logbooks always hold the stored values; they are converted only for display and CSV export.
"""

import math
from typing import Optional

UNITS = ("imperial", "metric")

# field -> kind of value.  avg_speed is calculated, not stored (see avg_speed()).
UNIT_FIELDS = {"exit_alt_ft": "alt", "deploy_alt_ft": "alt", "ground_alt_ft": "alt",
               "tas_3k": "speed", "tas_6k": "speed", "tas_9k": "speed", "tas_12k": "speed",
               "avg_speed": "speed"}

M_TO_FT = 3.28084
MS_TO_MPH = 2.23694
MS_TO_KMH = 3.6


def to_units(value, kind: str, units: str = "imperial"):
    """Convert a stored value (m or m/s) to `units`.  Speeds are truncated, as the altimeter shows them."""
    if value is None:
        return None
    if kind == "speed":
        return int(math.floor(value * (MS_TO_KMH if units == "metric" else MS_TO_MPH)))
    return value if units == "metric" else int(round(value * M_TO_FT))


def unit_label(kind: str, units: str = "imperial") -> str:
    if kind == "speed":
        return "km/h" if units == "metric" else "mph"
    return "m" if units == "metric" else "ft"


def unit_column(column: str, units: str = "imperial") -> str:
    """CSV/JSON field name for `column` in `units`, e.g. exit_alt_m or tas_3k_mph."""
    kind = UNIT_FIELDS.get(column)
    if kind == "alt":
        return column[:-3] + "_m" if units == "metric" and column.endswith("_ft") else column
    if kind == "speed":
        return "%s_%s" % (column, "kmh" if units == "metric" else "mph")
    return column


def avg_speed(jump: dict) -> Optional[float]:
    """Average freefall speed in m/s, worked out as the altimeter does: freefall distance / freefall time."""
    ff, exit_alt, deploy = jump.get("freefall_time_s"), jump.get("exit_alt_ft"), jump.get("deploy_alt_ft")
    if not ff or exit_alt is None or deploy is None:
        return None
    return (exit_alt - deploy) / ff


def hms(seconds: int) -> str:
    return "%d:%02d:%02d" % (seconds // 3600, seconds // 60 % 60, seconds % 60)


def convert_jump(jump: dict, units: str = "imperial") -> dict:
    """Copy of a logbook jump with every stored unit field converted to `units` and renamed."""
    out = {}
    for k, v in jump.items():
        kind = UNIT_FIELDS.get(k)
        out[unit_column(k, units) if kind else k] = to_units(v, kind, units) if kind else v
    return out
