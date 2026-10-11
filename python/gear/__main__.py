"""Offline author tools. Project commands use the installed gear Node CLI."""

import argparse
import json


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m gear")
    parser.add_argument("command", choices=["toy", "training", "algorithm"])
    args, rest = parser.parse_known_args()
    if args.command == "training":
        import sys

        from .training.cli import main as training_main

        sys.argv = [sys.argv[0], *rest]
        training_main()
    elif args.command == "algorithm":
        command = argparse.ArgumentParser(prog="python -m gear algorithm")
        command.add_argument("action", choices=["test"])
        command.add_argument("entrypoint")
        command.add_argument("--source", default=".")
        command.add_argument("--kind", choices=["auto", "algorithm", "parent"], default="auto")
        options = command.parse_args(rest)
        from .testing.authoring import check_entrypoint

        print(
            json.dumps(
                check_entrypoint(options.entrypoint, source=options.source, kind=options.kind)
            )
        )
    else:
        if rest:
            parser.error("toy takes no additional arguments")
        from .algorithms import GEPA
        from .testing import toy_round

        result = toy_round(GEPA())
        print(json.dumps({k: v for k, v in result.items() if k != "decisions"}))


if __name__ == "__main__":
    main()
