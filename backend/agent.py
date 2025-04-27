import asyncio
import json
import time
from typing import Any, Dict, List, Set

import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
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
    ctx.logger.info(f"Received request: {req}")
    ctx.logger.info(f"Action: {req.action}")
    ctx.logger.info(f"Target: {req.target}")
    ctx.logger.info(f"Raw Text: {req.rawText}")

    # Process the request (this could be replaced with actual processing logic)
    response_text = f"Processing {req.action} on {req.target}"
    
    # Broadcast the request and response via websocket

    time.sleep(20)

    await ws_manager.send_to_client("1", {"text": "Testing responses", "type": "request_processed", "action": "TESTING"})

    return Response(
        text=response_text,
        agent_address=ctx.agent.address,
    )

async def start_fastapi():
    import uvicorn
    config = uvicorn.Config(app, host="0.0.0.0", port=8001)
    server = uvicorn.Server(config)
    await server.serve()

if __name__ == "__main__":
    # Run FastAPI in a separate task
    import nest_asyncio
    nest_asyncio.apply()
    
    loop = asyncio.get_event_loop()
    loop.create_task(start_fastapi())
    
    agent.run()