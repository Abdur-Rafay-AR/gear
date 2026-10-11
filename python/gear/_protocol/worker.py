"""One bounded request per process; stdout is exclusively protocol output."""

import importlib
import json
import sys
from contextlib import redirect_stdout
from dataclasses import asdict

from ..algorithms import GEPA, Candidate, SearchView
from .canonical import digest
from .generated import PROTOCOL

PROTOCOL_VERSION = PROTOCOL["protocolVersion"]
MAX_BYTES = PROTOCOL["maxBytes"]


def main():
    raw = sys.stdin.buffer.readline(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES or not raw.endswith(b"\n"):
        raise ValueError("protocol-message-size")
    request = json.loads(raw)
    required = set(PROTOCOL["requestFields"])
    if set(request) != required or request["protocol_version"] != PROTOCOL_VERSION:
        raise ValueError("protocol-version-or-fields")
    if request["capabilities"] != PROTOCOL["capabilities"]:
        raise ValueError("protocol-capability-mismatch")
    if (
        not isinstance(request["request_id"], str)
        or not isinstance(request["run_id"], str)
        or type(request["step_id"]) is not int
        or request["step_id"] < 0
    ):
        raise ValueError("protocol-envelope-fields")
    payload = request["input"]
    if digest(payload) != request["input_digest"]:
        raise ValueError("protocol-input-digest")
    view = payload["view"]
    candidates = tuple(
        Candidate(c["id"], dict(c["scores"]), c.get("content_digest")) for c in view["candidates"]
    )
    projection = SearchView(
        tuple(view["seed_tasks"]),
        candidates,
        view["champion"],
        view["max_candidates"],
        view["remaining_evaluations"],
        view["random_seed"],
        view["completed"],
        view.get("task_families", {}),
    )
    with redirect_stdout(sys.stderr):
        algorithm = GEPA()
        if len(sys.argv) > 1:
            module, name = sys.argv[1].split(":")
            algorithm = getattr(importlib.import_module(module), name)()
        decision = algorithm.step(projection, payload["state"])
    response = {key: value for key, value in request.items() if key != "input"}
    response["decision"] = asdict(decision)
    encoded = json.dumps(response, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_BYTES:
        raise ValueError("protocol-message-size")
    print(encoded)


if __name__ == "__main__":
    main()
