import asyncio
import sys


async def run_process(cmd):
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    
    async def read_stream(stream, prefix):
        while True:
            line = await stream.readline()
            if not line:
                break
            print(f"{prefix}: {line.decode().strip()}")
    
    await asyncio.gather(
        read_stream(process.stdout, cmd),
        read_stream(process.stderr, f"{cmd} [ERR]")
    )
    
    return await process.wait()

async def main():
    await asyncio.gather(
        run_process("agents.browser"),
        run_process("agents.orchestrator"),
        run_process("agents.voice")
    )

if __name__ == "__main__":
    asyncio.run(main())