"""Public CPU-only author checks and toy execution."""

from .conformance import check_algorithm
from .toy import toy_round

__all__ = ["check_algorithm", "toy_round"]
