from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from uagents import Agent, Context, Model

# app = FastAPI()

# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=["*"],
#     allow_credentials=True,
#     allow_methods=["*"],
#     allow_headers=["*"],
# )

class Request(Model):
    action: str
    target: str
    rawText: str

class Response(Model):
    text: str
    agent_address: str

class Message(Model):
    message: str

SEED_PHRASE = "fe27d512a581c0dad0c447bf03006c60"

agent = Agent(
        name="Hermes",
        seed=SEED_PHRASE,
        mailbox=True,
    )

@agent.on_rest_post("/query", Request, Response)
async def handle_post(ctx: Context, req: Request) -> Response:
    ctx.logger.info(f"Received request: {req}")
    ctx.logger.info(f"Action: {req.action}")
    ctx.logger.info(f"Target: {req.target}")
    ctx.logger.info(f"Raw Text: {req.rawText}")


    return Response(
        text=f"Received: {req.text}",
        agent_address=ctx.agent.address,
    )

# @app.post("/query")
# async def query(request: QueryRequest):

#     print("Received request:")
#     print(f"Action: {request.action}")
#     print(f"Target: {request.target}")
#     print(f"Raw Text: {request.rawText}")

#     agent = Agent(
#         name="Hermes",
#         seed=SEED_PHRASE,
#         mailbox=True,
#     )

#     print(f"Agent Address: {agent.address}")

#     agent.run()

#     return {
#         "action": request.action,
#         "target": request.target,
#         "rawText": request.rawText,
#         "message": "Request processed"
#     }