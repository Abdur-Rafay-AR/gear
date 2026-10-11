"""Structure validation for generated wire schemas; no author/runtime semantics."""

from __future__ import annotations

import math
from typing import Any, NoReturn


def _invalid(path: str) -> NoReturn:
    raise ValueError(f"protocol-payload-invalid: {path}")


def _json(value: Any, path: str, depth: int, limit: int, active: set[int]) -> None:
    if depth > limit:
        _invalid(path)
    if value is None or type(value) is bool:
        return
    if type(value) is str:
        try:
            value.encode("utf-8", errors="strict")
        except UnicodeError:
            _invalid(path)
        return
    if type(value) in (int, float):
        if type(value) is int and abs(value) > 2**53 - 1:
            _invalid(path)
        if not math.isfinite(value) or (float(value).is_integer() and abs(value) > 2**53 - 1):
            _invalid(path)
        return
    if type(value) not in (list, tuple, dict) or id(value) in active:
        _invalid(path)
    active.add(id(value))
    if type(value) in (list, tuple):
        for i, item in enumerate(value):
            _json(item, f"{path}[{i}]", depth + 1, limit, active)
    else:
        for key, item in value.items():
            if type(key) is not str:
                _invalid(path)
            _json(key, path, depth, limit, active)
            _json(item, f"{path}.*", depth + 1, limit, active)
    active.remove(id(value))


def _matches(value: Any, schema: dict[str, Any], types: dict[str, Any], path: str) -> None:
    if "$ref" in schema:
        return _matches(value, types[schema["$ref"].removeprefix("#/$defs/")], types, path)
    if "const" in schema and (type(value) is bool or value != schema["const"]):
        _invalid(path)
    if "enum" in schema and value not in schema["enum"]:
        _invalid(path)
    if "anyOf" in schema:
        for choice in schema["anyOf"]:
            try:
                _matches(value, choice, types, path)
                return
            except ValueError:
                pass
        _invalid(path)
    kind = schema.get("type")
    if kind == "null" and value is not None:
        _invalid(path)
    if kind == "string" and (type(value) is not str or len(value) < schema.get("minLength", 0)):
        _invalid(path)
    if kind in ("number", "integer") and (
        type(value) not in (float, int)
        or (kind == "integer" and not float(value).is_integer())
        or value < schema.get("minimum", -math.inf)
        or value > schema.get("maximum", math.inf)
    ):
        _invalid(path)
    if kind == "array":
        if (
            type(value) not in (list, tuple)
            or len(value) < schema.get("minItems", 0)
            or len(value) > schema.get("maxItems", math.inf)
        ):
            _invalid(path)
        for i, item in enumerate(value):
            _matches(item, schema["items"], types, f"{path}[{i}]")
        if schema.get("uniqueItems") and len(set(value)) != len(value):
            _invalid(path)
    if kind == "object":
        if type(value) is not dict or any(k not in value for k in schema.get("required", ())):
            _invalid(path)
        for key, item in value.items():
            child = schema.get("properties", {}).get(key)
            if child is not None:
                _matches(item, child, types, f"{path}.{key}")
            elif schema.get("additionalProperties") is False:
                _invalid(path)
            elif isinstance(schema.get("additionalProperties"), dict):
                _matches(item, schema["additionalProperties"], types, f"{path}.*")


def validate_wire(value: Any, name: str, types: dict[str, Any], max_depth: int) -> None:
    if name not in types:
        raise ValueError("protocol-schema-unknown")
    _json(value, "$", 0, max_depth, set())
    _matches(value, types[name], types, "$")
