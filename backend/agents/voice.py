import asyncio
from typing import Dict, List

import nest_asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from uagents import Agent, Context, Model


# Define your models
class Request(Model):
    text: str

class Response(Model):
    text: str
    agent_address: str

class Message(Model):
    message : str
    field : int

class WebSocketManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.client_map: Dict[str, WebSocket] = {}  # Map client IDs to WebSocket connections

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        print(f"Broadcasting message: {message}")
        print(f"Active connections: {len(self.active_connections)}")
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                # Connection might be closed, will be removed on next connect/disconnect
                pass

    async def send_to_client(self, client_id: str, message: dict):
        if client_id in self.client_map:
            try:
                await self.client_map[client_id].send_json(message)
            except Exception:
                # Connection might be closed
                del self.client_map[client_id]
        else:
            # Client not found or not connected
            pass


SEED_PHRASE = "fe27d512a581c0dad0c447bf03006c60"

agent = Agent(
    name="Hermes",
    seed=SEED_PHRASE,
    mailbox=True,
)

ZEUS = "zeus"
ORCHESTRATOR_ADDRESS = "agent1qw960vhw0yv29c0fmgn8jcwspqe0xlyxldn5cp7a9hjvm6lm3cx6jjzunxh"

# Initialize WebSocket manager
ws_manager = WebSocketManager()

# Create FastAPI app to handle WebSockets
app = FastAPI()

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Adjust in production to specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await ws_manager.connect(websocket)
    # Store the client ID mapping
    ws_manager.client_map[client_id] = websocket
    try:
        while True:
            # Keep connection alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
        # Remove from client map
        if client_id in ws_manager.client_map:
            del ws_manager.client_map[client_id]

@agent.on_rest_post("/query", Request, Response)
async def handle_post(ctx: Context, req: Request) -> Response:
    ctx.logger.info(f"[Hermes] Received /query: {req.text}")
    await ctx.send(ORCHESTRATOR_ADDRESS, req)
    return Response(
        text="I've sent your request to the orchestrator.",
        agent_address=ctx.agent.address,
    )

@agent.on_message(model=Response)
async def handle_response(ctx: Context, sender: str, res: Response):
    # this is where you'd hook in your TTS or voice-output
    ctx.logger.info(f"[Hermes → user] {res.text}")
    await ws_manager.broadcast({
        "message": res.text,
        "agent_address": res.agent_address
    })

@app.get("/")
async def root():
    await ws_manager.broadcast({
        "message": "Hermes is running and ready to receive messages.",
        "agent_address": ORCHESTRATOR_ADDRESS
    })
    
    # If you want to send to a specific client (if you have client_id)
    # client_id = "some_client_id"  # You would need to determine this
    # await ws_manager.send_to_client(client_id, {
    #     "text": res.text,
    #     "agent_address": res.agent_address
    # })
    return {"message": "Hermes is running and ready to receive messages."}


async def start_fastapi():
     import uvicorn
     config = uvicorn.Config(app, host="0.0.0.0", port=8004)
     server = uvicorn.Server(config)
     await server.serve()

nest_asyncio.apply()

loop = asyncio.get_event_loop()
loop.create_task(start_fastapi())

agent.run()