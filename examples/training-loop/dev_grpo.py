"""Compatibility launcher. Prefer python -m gear.training run SPEC --config CONFIG."""
from gear.training.dev_launcher import main

if __name__ == "__main__":
    raise SystemExit(main())
