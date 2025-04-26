import time
from typing import Any, Dict

from uagents import Agent, Context, Model


# Define your models
class Request(Model):
    action: str
    target: str
    rawText: str

class Response(Model):
    text: str
    agent_address: str

class Message(Model):
    message : str
    field : int

SEED_PHRASE = "fe27d512a581c0dad0c447bf03006c60"

agent = Agent(
        name="Hermes",
        seed=SEED_PHRASE,
        mailbox=True,
    )

ZEUS = "zeus"

@agent.on_rest_post("/query", Request, Response)
async def handle_post(ctx: Context, req: Request) -> Response:
    ctx.logger.info(f"Received request: {req}")
    ctx.logger.info(f"Action: {req.action}")
    ctx.logger.info(f"Target: {req.target}")
    ctx.logger.info(f"Raw Text: {req.rawText}")

    # await ctx.send(ZEUS, Message(message = 'Hi Second Agent, this is the first agent.'))

    return Response(
        text="I've sent your request to the second agent.",
        agent_address=ctx.agent.address,
    )

if __name__ == "__main__":
    agent.run()