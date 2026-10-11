"""Set algorithm: {source: ./algorithm, entrypoint: policy:build_algorithm}."""
from gear.algorithms import GEPA, SearchView


def champion_parent(view: SearchView) -> str:
    return view.champion


def build_algorithm() -> GEPA:
    return GEPA(parent_policy=champion_parent)


if __name__ == "__main__":
    from gear.testing import toy_round
    print(toy_round(build_algorithm())["nominee"])
