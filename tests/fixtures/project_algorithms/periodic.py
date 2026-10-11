from gear.algorithms import EpochPolicy, StagedGEPA
from gear.algorithms.gepa.scopes import ScopeConfig, TaskSetLimit


def build_algorithm():
    return StagedGEPA(
        scope_config=ScopeConfig(
            local=TaskSetLimit(0.2), shared=TaskSetLimit(0), cross=TaskSetLimit(0)
        ),
        epoch_policy=EpochPolicy(update_every_rounds=1),
        batch_size=1,
        bridge_max_candidates=0,
    )
