"""Compatibility import; use gear.training.recipes.dev_script for new code."""
from importlib import import_module as _import_module
import sys as _sys
_impl = _import_module('gear.training.recipes.dev_script')
globals().update({k: v for k, v in vars(_impl).items() if not k.startswith("__")})
