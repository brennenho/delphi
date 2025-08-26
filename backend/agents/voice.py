import asyncio
import json
import os
import base64
from typing import Dict, List
import logging
import tempfile
import subprocess
import hashlib
import time

import nest_asyncio
import websockets
import websockets.exceptions
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request as FastAPIRequest
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from uagents import Agent, Context, Model
from pydantic import BaseModel

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class AgentRequest(Model):
    text: str

class Response(Model):
    text: str
    agent_address: str

class Message(Model):
    message : str
    field : int

class TranscriptionRequest(BaseModel):
    audioBase64: str
    mimeType: str = "audio/wav"

class TranscriptionResponse(BaseModel):
    transcription: str

class BrowserQueryRequest(BaseModel):
    text: str

class BrowserQueryResponse(BaseModel):
    isBrowserQuery: bool
    query: str = None

class TTSRequest(BaseModel):
    text: str
    voice: str = "en-US-Journey-F"

class TTSResponse(BaseModel):
    audioBase64: str
    mimeType: str = "audio/mp3"

# TTS Configuration and state management
class TTSManager:
    def __init__(self):
        self.last_tts_time = 0
        self.tts_queue = []
        self.processing_tts = False
        self.last_description_hash = None
        
    async def generate_speech(self, text: str) -> str:
        """Generate speech using available TTS services"""
        try:
            # Try Google TTS first (if available)
            if os.getenv("GOOGLE_CLOUD_TTS_KEY"):
                return await self._generate_google_tts(text)
            
            # Fallback to espeak (system TTS) 
            return await self._generate_espeak_tts(text)
            
        except Exception as e:
            logger.error(f"TTS generation failed: {e}")
            # Return text as base64 as final fallback
            return base64.b64encode(text.encode()).decode()
    
    async def _generate_google_tts(self, text: str) -> str:
        """Generate TTS using Google Cloud Text-to-Speech"""
        try:
            from google.cloud import texttospeech
            
            client = texttospeech.TextToSpeechClient()
            
            synthesis_input = texttospeech.SynthesisInput(text=text)
            voice = texttospeech.VoiceSelectionParams(
                language_code="en-US",
                ssml_gender=texttospeech.SsmlVoiceGender.FEMALE
            )
            audio_config = texttospeech.AudioConfig(
                audio_encoding=texttospeech.AudioEncoding.MP3
            )
            
            response = client.synthesize_speech(
                input=synthesis_input, voice=voice, audio_config=audio_config
            )
            
            return base64.b64encode(response.audio_content).decode()
            
        except ImportError:
            logger.warning("Google Cloud TTS not available, falling back to system TTS")
            return await self._generate_espeak_tts(text)
        except Exception as e:
            logger.error(f"Google TTS error: {e}")
            return await self._generate_espeak_tts(text)
    
    async def _generate_espeak_tts(self, text: str) -> str:
        """Generate TTS using espeak (system TTS)"""
        try:
            # Create temporary file for audio output
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_file:
                temp_path = temp_file.name
            
            # Use espeak to generate speech
            cmd = [
                "espeak", 
                "-s", "160",  # Speed
                "-p", "50",   # Pitch
                "-a", "100",  # Amplitude
                "-v", "en+f3", # Voice (female variant)
                "-w", temp_path,  # Output to wav file
                text
            ]
            
            # Run espeak in subprocess
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            await process.communicate()
            
            # Read the generated audio file
            with open(temp_path, "rb") as audio_file:
                audio_data = audio_file.read()
            
            # Clean up temp file
            os.unlink(temp_path)
            
            return base64.b64encode(audio_data).decode()
            
        except Exception as e:
            logger.error(f"Espeak TTS error: {e}")
            # Final fallback - return empty audio or text
            return base64.b64encode(b"").decode()
    
    def should_generate_tts(self, text: str) -> bool:
        """Determine if TTS should be generated for this text"""
        current_time = time.time()
        
        # Rate limiting - don't generate TTS more than once every 2 seconds
        if current_time - self.last_tts_time < 2:
            return False
        
        # Avoid duplicate TTS for same content
        text_hash = hashlib.md5(text.encode()).hexdigest()
        if text_hash == self.last_description_hash:
            return False
            
        self.last_description_hash = text_hash
        self.last_tts_time = current_time
        return True
    
    async def queue_tts(self, text: str):
        """Queue TTS generation for processing"""
        if self.should_generate_tts(text):
            self.tts_queue.append(text)
            if not self.processing_tts:
                await self._process_tts_queue()
    
    async def _process_tts_queue(self):
        """Process queued TTS requests"""
        if self.processing_tts:
            return
            
        self.processing_tts = True
        
        try:
            while self.tts_queue:
                text = self.tts_queue.pop(0)
                logger.info(f"Generating TTS for: {text}")
                
                audio_data = await self.generate_speech(text)
                
                # Broadcast TTS audio to connected clients
                message = {
                    "type": "tts_audio",
                    "audio_base64": audio_data,
                    "mime_type": "audio/wav",
                    "text": text,
                    "timestamp": time.time()
                }
                await ws_manager.broadcast(message)
                logger.info(f"TTS audio broadcasted for: {text[:50]}...")
                
        except Exception as e:
            logger.error(f"Error processing TTS queue: {e}")
        finally:
            self.processing_tts = False

# Initialize TTS manager
tts_manager = TTSManager()

class GeminiWebSocketProxy:
    def __init__(self):
        self.gemini_ws = None
        self.client_ws = None
        self.api_key = os.getenv("GEMINI_API_KEY")
        self.model = "models/gemini-2.0-flash-live-001"
        self.host = "generativelanguage.googleapis.com"
        self.gemini_url = f"wss://{self.host}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key={self.api_key}"
        
        if not self.api_key:
            raise ValueError("GEMINI_API_KEY environment variable not found")
        
    async def connect_to_gemini(self):
        try:
            self.gemini_ws = await websockets.connect(self.gemini_url)
            return True
        except Exception as e:
            print(f"Failed to connect to Gemini: {e}")
            return False
    
    async def setup_gemini_session(self, setup_message: dict, client_ws: WebSocket):
        if not self.gemini_ws:
            return False
        
        try:
            await self.gemini_ws.send(json.dumps(setup_message))
            
            # Wait for setup completion response
            try:
                response = await self.gemini_ws.recv()
                
                # Forward setup response to client
                await client_ws.send_text(response)
                
                # Parse the response to check if setup is complete
                response_data = json.loads(response)
                return "setupComplete" in response_data or True  # Continue anyway
            except Exception as recv_error:
                print(f"Error receiving setup response: {recv_error}")
                return False
                
        except Exception as e:
            print(f"Failed to setup Gemini session: {e}")
            return False
    
    async def send_to_gemini(self, message: dict):
        if self.gemini_ws:
            try:
                await self.gemini_ws.send(json.dumps(message))
            except Exception as e:
                print(f"Error sending to Gemini: {e}")
    
    async def listen_to_gemini(self, client_ws: WebSocket):
        if not self.gemini_ws:
            return
            
        try:
            while True:
                try:
                    message = await self.gemini_ws.recv()
                    await client_ws.send_text(message)
                except websockets.exceptions.ConnectionClosed:
                    break
                except Exception as e:
                    print(f"Error forwarding message to client: {e}")
                    break
        except Exception as e:
            print(f"Error listening to Gemini: {e}")
    
    async def close(self):
        if self.gemini_ws:
            await self.gemini_ws.close()
            self.gemini_ws = None

class WebSocketManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.client_map: Dict[str, WebSocket] = {}
        self.gemini_proxies: Dict[str, GeminiWebSocketProxy] = {} 

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

    async def broadcast_vision_description(self, description: str):
        """Broadcast vision description to all connected clients and generate TTS"""
        message = {
            "type": "vision_description",
            "message": description,
            "timestamp": asyncio.get_event_loop().time()
        }
        await self.broadcast(message)
        
        # Also generate TTS for the description
        await tts_manager.queue_tts(description)
        
        logger.info(f"Broadcasted vision description with TTS: {description}")


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

# Create rate limiter
limiter = Limiter(key_func=get_remote_address)

# Create FastAPI app to handle WebSockets
app = FastAPI()
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

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

@app.websocket("/gemini-proxy/{client_id}")
async def gemini_proxy_websocket(websocket: WebSocket, client_id: str):
    await websocket.accept()
    
    # Create Gemini proxy for this client
    proxy = GeminiWebSocketProxy()
    ws_manager.gemini_proxies[client_id] = proxy
    
    # Connect to Gemini
    if not await proxy.connect_to_gemini():
        await websocket.close(code=1011, reason="Failed to connect to Gemini")
        return
    
    gemini_listen_task = None
    
    try:
        # Listen to client messages
        while True:
            try:
                message = await websocket.receive_text()
                
                # Forward message to Gemini
                message_data = json.loads(message)
                
                # Handle setup messages specially
                if "setup" in message_data:
                    setup_success = await proxy.setup_gemini_session(message_data, websocket)
                    if setup_success and not gemini_listen_task:
                        # Start listening to Gemini after successful setup
                        gemini_listen_task = asyncio.create_task(proxy.listen_to_gemini(websocket))
                else:
                    await proxy.send_to_gemini(message_data)
            except WebSocketDisconnect:
                break
            except json.JSONDecodeError:
                print(f"Invalid JSON from client {client_id}")
            except Exception as e:
                print(f"Error handling client message: {e}")
                break
                
    except Exception as e:
        print(f"Error in Gemini proxy: {e}")
    finally:
        # Cleanup
        if gemini_listen_task:
            gemini_listen_task.cancel()
        await proxy.close()
        if client_id in ws_manager.gemini_proxies:
            del ws_manager.gemini_proxies[client_id]

@agent.on_rest_post("/query", AgentRequest, Response)
async def handle_post(ctx: Context, req: AgentRequest) -> Response:
    ctx.logger.info(f"[Hermes] Received /query: {req.text}")
    await ctx.send(ORCHESTRATOR_ADDRESS, req)
    return Response(
        text="I've sent your request to the orchestrator.",
        agent_address=ctx.agent.address,
    )

@agent.on_message(model=Response)
async def handle_response(ctx: Context, _sender: str, res: Response):
    # Handle responses from other agents, including vision descriptions
    ctx.logger.info(f"[Hermes → user] {res.text}")
    
    # Broadcast to WebSocket clients
    await ws_manager.broadcast({
        "message": res.text,
        "agent_address": res.agent_address
    })
    
    # Check if this is a vision description and broadcast specially
    if "I " in res.text and any(word in res.text.lower() for word in ["clicked", "typed", "opened", "see", "navigated"]):
        await ws_manager.broadcast_vision_description(res.text)
        ctx.logger.info(f"Processed vision description: {res.text}")



@app.post("/tts", response_model=TTSResponse)
@limiter.limit("20/minute")
async def text_to_speech(request: FastAPIRequest, tts_request: TTSRequest):
    try:
        # Generate TTS directly for API endpoint
        audio_base64 = await tts_manager.generate_speech(tts_request.text)
        return TTSResponse(
            audioBase64=audio_base64,
            mimeType="audio/wav"
        )
    except Exception as e:
        logger.error(f"TTS error: {e}")
        raise HTTPException(status_code=500, detail=f"TTS failed: {str(e)}")

@app.post("/transcribe", response_model=TranscriptionResponse)
@limiter.limit("10/minute")
async def transcribe_audio(request: FastAPIRequest, transcription_request: TranscriptionRequest):
    try:
        import google.generativeai as genai
        
        # Configure Gemini
        genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
        model = genai.GenerativeModel("gemini-1.5-flash-002")
        
        # Decode base64 audio data
        audio_data = base64.b64decode(transcription_request.audioBase64)
        
        # Create the content with audio and prompt
        prompt = "Please transcribe the spoken language in this audio accurately. Ignore any background noise or non-speech sounds."
        
        response = await asyncio.to_thread(
            model.generate_content,
            [
                prompt,
                {
                    "mime_type": transcription_request.mimeType,
                    "data": audio_data
                }
            ]
        )
        
        transcription = response.text
        return TranscriptionResponse(transcription=transcription)
        
    except Exception as e:
        print(f"Transcription error: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

@app.post("/browser-query", response_model=BrowserQueryResponse)
@limiter.limit("20/minute")
async def classify_browser_query(request: FastAPIRequest, query_request: BrowserQueryRequest):
    try:
        import google.generativeai as genai
        
        # Configure Gemini
        genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
        model = genai.GenerativeModel("gemini-1.5-flash-002")
        
        classification_prompt = f"""Determine if the following user query is related to browser tasks, web navigation, web search, opening websites, 
interacting with web content, or other web-related activities.

Examples of browser queries:
- "Search for Italian restaurants near me"
- "Go to nytimes.com"
- "Open my Gmail"
- "Show me the weather forecast"
- "Find cheap flights to Paris"
- "Navigate to YouTube"
- "Look up how to bake chocolate cookies"

Examples of non-browser queries:
- "What's your name?"
- "Tell me a joke"
- "Can you write a poem?"
- "What's the meaning of life?"
- "Describe your capabilities"

User query: "{query_request.text.strip()}"

Respond with ONLY "BROWSER_QUERY" if it's a browser-related query, or "NOT_BROWSER_QUERY" if it's not."""

        response = await asyncio.to_thread(model.generate_content, classification_prompt)
        classification = response.text.strip()
        
        is_browser_query = classification == "BROWSER_QUERY"
        
        return BrowserQueryResponse(
            isBrowserQuery=is_browser_query,
            query=query_request.text.strip() if is_browser_query else None
        )
        
    except Exception as e:
        print(f"Classification error: {e}")
        raise HTTPException(status_code=500, detail=f"Classification failed: {str(e)}")

@app.get("/")
async def root():
    await ws_manager.broadcast({
        "message": "Hermes is running and ready to receive messages.",
        "agent_address": ORCHESTRATOR_ADDRESS
    })
    
    return {"message": "Hermes is running and ready to receive messages."}


async def start_fastapi():
     import uvicorn
     config = uvicorn.Config(app, host="0.0.0.0", port=8000)  # Changed port to 8000
     server = uvicorn.Server(config)
     await server.serve()

nest_asyncio.apply()

loop = asyncio.get_event_loop()
loop.create_task(start_fastapi())

agent.run()