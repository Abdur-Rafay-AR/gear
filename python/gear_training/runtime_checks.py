"""Compatibility forwarding module; implementation lives in gear.training.runtime_checks."""
import importlib as _importlib
import runpy as _runpy
import sys as _sys

if __name__ == "__main__":
    _runpy.run_module('gear.training.runtime_checks', run_name="__main__")
else:
    _sys.modules[__name__] = _importlib.import_module('gear.training.runtime_checks')
