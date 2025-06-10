import os
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import websockets
import google.generativeai as genai

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_HOST = "generativelanguage.googleapis.com"
GEMINI_WS_URL = f"wss://{GEMINI_HOST}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key={GEMINI_API_KEY}"
genai.configure(api_key=GEMINI_API_KEY)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/transcribe")
async def transcribe(payload: dict):
    data = payload.get("data")
    mime = payload.get("mime_type", "audio/wav")
    if not data:
        raise HTTPException(status_code=400, detail="missing data")
    model = genai.GenerativeModel("gemini-1.5-flash-8b")
    result = await asyncio.to_thread(model.generate_content, [
        {"inlineData": {"data": data, "mimeType": mime}},
        {"text": "Please transcribe the spoken language in this audio accurately."},
    ])
    return {"text": result.text.strip()}

@app.post("/classify")
async def classify(payload: dict):
    text = payload.get("text", "")
    model = genai.GenerativeModel("gemini-1.5-flash-8b")
    prompt = [
        {
            "text": f"Determine if the following user query is related to browser tasks. Respond with ONLY 'BROWSER_QUERY' or 'NOT_BROWSER_QUERY'.\nUser query: '{text}'"
        }
    ]
    result = await asyncio.to_thread(model.generate_content, prompt)
    return {"label": result.text.strip()}

@app.websocket("/gemini")
async def gemini_ws(websocket: WebSocket):
    await websocket.accept()
    if not GEMINI_API_KEY:
        await websocket.close(code=1008)
        return
    try:
        async with websockets.connect(GEMINI_WS_URL) as ws:
            async def client_to_gemini():
                try:
                    while True:
                        msg = await websocket.receive_text()
                        await ws.send(msg)
                except WebSocketDisconnect:
                    pass
                finally:
                    await ws.close()

            async def gemini_to_client():
                try:
                    async for msg in ws:
                        await websocket.send_text(msg)
                except websockets.ConnectionClosed:
                    pass

            await asyncio.gather(client_to_gemini(), gemini_to_client())
    finally:
        await websocket.close()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8005)
