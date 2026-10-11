from gear.algorithms import StagedGEPA
from gear.algorithms.gepa.scopes import ScopeConfig, TaskSetLimit


def build_algorithm():
    return StagedGEPA(ScopeConfig(local=TaskSetLimit(1), shared=TaskSetLimit(0), cross=TaskSetLimit(0),
                                 bridge=TaskSetLimit(1)), batch_size=1)
