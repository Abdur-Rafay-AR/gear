import hashlib
import json
import math
import struct


def _normalized(value: object) -> list[object]:
    if value is None:
        return ["null"]
    if isinstance(value, bool):
        return ["bool", "true" if value else "false"]
    if isinstance(value, str):
        value.encode("utf-8", errors="strict")
        return ["string", value]
    if isinstance(value, (float, int)):
        if not math.isfinite(value) or (float(value).is_integer() and abs(value) > 2**53 - 1):
            raise ValueError("canonical number out of range")
        return ["number", struct.pack(">d", 0 if value == 0 else value).hex()]
    if isinstance(value, (list, tuple)):
        return ["array", [_normalized(item) for item in value]]
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return ["object", [[_normalized(key), _normalized(value[key])] for key in sorted(value)]]
    raise ValueError("canonical value must be JSON data")


def digest(value: object) -> str:
    text = json.dumps(_normalized(value), ensure_ascii=False, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(b"gear-canonical-v1\0" + text.encode("utf-8")).hexdigest()
