"""Public Gear SDK. Importing Gear does not initialize workers or GPU backends."""

from .project import GearError, Project

__all__ = ["GearError", "Project"]
__version__ = "0.1.3"
