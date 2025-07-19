import os
from collections import deque
from dotenv import load_dotenv
from uagents import Agent as UAgent, Context, Model

load_dotenv()
SEED = os.getenv("ORCHESTRATOR_SEED")

# Address of your BrowserAgent
BROWSER_AGENT_ADDRESS = os.getenv("BROWSER_AGENT_ADDRESS")

class Request(Model):
    text: str

class Response(Model):
    text: str
    agent_address: str

class BrowserTask(Model):
    task: str

class BrowserResult(Model):
    status: str
    detail: str

# --- Orchestrator setup ---
orchestrator = UAgent(
    name="Zeus",
    port=8002,
    seed=SEED,
    mailbox=True,
)

# --- Internal state ---
pending   = deque()  # queue of (task_text, user_addr)
in_flight = None     # (task_text, user_addr)

# --- Helpers ---
async def dispatch_next(ctx: Context):
    global in_flight
    if in_flight or not pending:
        return

    task_text, user_addr = pending.popleft()
    in_flight = (task_text, user_addr)
    await ctx.send(
        BROWSER_AGENT_ADDRESS,
        BrowserTask(task=task_text),
    )

# --- Handlers ---

@orchestrator.on_message(model=Request)
async def on_user(ctx: Context, sender: str, req: Request):
    global pending, in_flight

    # Directly enqueue the full text as a single task
    pending.append((req.text, sender))

    await dispatch_next(ctx)

@orchestrator.on_message(model=BrowserResult)
async def on_result(ctx: Context, sender: str, res: BrowserResult):
    global in_flight

    if not in_flight:
        return

    task_text, user_addr = in_flight

    if res.status == "done":
        status_text = "Task has succeeded."
    else:
        status_text = "Task has failed."

    response_text = f"{status_text} {res.detail}"

    await ctx.send(
        user_addr,
        Response(
            text=response_text,
            agent_address=ctx.agent.address
        ),
    )

    in_flight = None
    await dispatch_next(ctx)

if __name__ == "__main__":
    orchestrator.run()
