"""Benchmark operations use the shared application service."""

from ..project import Project


class Benchmark:
    def __init__(self, project: Project):
        self.project = project

    def check(self) -> dict[str, object]:
        return self.project.check()

    def compile(self) -> dict[str, object]:
        return self.project.compile()

    async def acheck(self) -> dict[str, object]:
        return await self.project.acheck()

    async def acompile(self) -> dict[str, object]:
        return await self.project.acompile()
