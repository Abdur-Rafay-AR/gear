"""Compatibility import; use gear.training for new code."""
from importlib import import_module as _import_module
import sys as _sys
_impl = _import_module('gear.training')
from gear.training import *  # noqa: F403
