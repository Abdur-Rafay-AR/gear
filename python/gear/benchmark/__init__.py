"""Benchmark operations use the shared application service."""

from ..project import Project


class Benchmark:
    def __init__(self, project: Project):
        self.project = project

    def check(self) -> dict[str, object]:
        return self.project.check()

    def compile(self) -> dict[str, object]:
        return self.project._request("benchmark", "compile")
