import asyncio
import sys

async def run_process(cmd: str):
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def forward(stream, prefix):
        while True:
            line = await stream.readline()
            if not line:
                break
            print(f"{prefix}: {line.decode().rstrip()}")

    await asyncio.gather(
        forward(process.stdout, cmd),
        forward(process.stderr, f"{cmd} [ERR]"),
    )
    return await process.wait()

async def main():
    await asyncio.gather(
        run_process("agents.browser"),
        run_process("agents.orchestrator"),
        run_process("agents.voice"),
        run_process("gemini_proxy"),
    )

if __name__ == "__main__":
    asyncio.run(main())
