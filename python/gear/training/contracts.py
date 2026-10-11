"""CPU-only stage contracts, independent of optional execution backends."""
from .loop import DatasetBuilder, ModelUpdater, RolloutExecutor, TaskSource
from .loop import TrainingConfig, TrainingContext, TrainingResult

__all__ = ["DatasetBuilder", "ModelUpdater", "RolloutExecutor", "TaskSource",
           "TrainingConfig", "TrainingContext", "TrainingResult"]
