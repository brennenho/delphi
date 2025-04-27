import os
import re
from collections import deque

from dotenv import load_dotenv
from uagents import Agent as UAgent
from uagents import Context, Model

load_dotenv()
SEED = os.getenv("ORCHESTRATOR_SEED")

# Address of your BrowserAgent
BROWSER_AGENT_ADDRESS = os.getenv("BROWSER_AGENT_ADDRESS")

# --- Protocols ---
# user_protocol    = Protocol(name="UserProtocol",    version="1.0")
# browser_protocol = Protocol(name="BrowserProtocol", version="1.0")
# result_protocol  = Protocol(name="ResultProtocol",  version="1.0")

class Request(Model):
    action: str
    target: str
    rawText: str

class BrowserTask(Model):
    task: str

class BrowserResult(Model):
    status: str
    detail: str

class Response(Model):
    text: str
    agent_address: str

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
def parse_tasks(text: str) -> list[str]:
    parts = re.split(r'\band then\b|[,;]\s*', text, flags=re.IGNORECASE)
    return [p.strip() for p in parts if p.strip()]

async def dispatch_next(ctx: Context):
    global in_flight
    if in_flight:
        print(f"⏳ Already a task in flight: {in_flight}")
        return
    if not pending:
        print("📭 No pending tasks to dispatch.")
        return

    task_text, user_addr = pending.popleft()
    in_flight = (task_text, user_addr)
    print(f"🚀 Dispatching to BrowserAgent: '{task_text}' (for {user_addr})")

    await ctx.send(
        BROWSER_AGENT_ADDRESS,
        BrowserTask(task=task_text),
    )

# --- Handlers ---
@orchestrator.on_message(model=Request)
async def on_user(ctx: Context, sender: str, req: Request):
    global pending, in_flight

    print("📥 on_user received:")
    print(f"    sender:      {sender}")
    print(f"    action:      {req.action!r}")
    print(f"    target:      {req.target!r}")
    print(f"    rawText:     {req.rawText!r}")

    subtasks = parse_tasks(req.rawText)
    print(f"🔍 Parsed subtasks: {subtasks}")

    if in_flight:
        print("⛔ Interrupt detected! Clearing pending and in-flight tasks.")
        pending.clear()
        in_flight = None

    for t in subtasks:
        print(f"➕ Enqueueing task: {t}")
        pending.append((t, sender))

    await dispatch_next(ctx)

@orchestrator.on_message(model=BrowserResult)
async def on_result(ctx: Context, sender: str, res: BrowserResult):
    global in_flight

    print("📤 on_result received:")
    print(f"    from BrowserAgent: {sender}")
    print(f"    status:           {res.status!r}")
    print(f"    detail:           {res.detail!r}")

    if not in_flight:
        print("⚠️  No in-flight task but got a result—ignoring.")
        return

    task_text, user_addr = in_flight
    print(f"✅ Completing in-flight task: {task_text}")

    if res.status == "done":
        status_text = "Task has succeeded."
    else:
        status_text = "Task has failed."

    response_text = f"{status_text}{res.detail}"

    print(f"💬 Sending back to user ({user_addr}): {response_text!r}")

    await ctx.send(
        user_addr,
        Response(
            text=response_text,
            agent_address=ctx.agent.address
        ),
    )

    in_flight = None
    await dispatch_next(ctx)

# orchestrator.include(user_protocol,    publish_manifest=True)
# orchestrator.include(browser_protocol, publish_manifest=True)
# orchestrator.include(result_protocol,  publish_manifest=True)

if __name__ == "__main__":
    orchestrator.run()
