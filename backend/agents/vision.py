import os, base64
from io import BytesIO
from dotenv import load_dotenv
import google.generativeai as genai

from uagents import Agent, Context, Model

load_dotenv()

class ScreenshotTask(Model):
    image: str
    step_info: str

class Response(Model):
    text: str
    agent_address: str

genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
model = genai.GenerativeModel("gemini-2.0-flash-exp")

HERMES_ADDRESS = os.getenv("HERMES_ADDRESS")

SEED = "theia-random-secure-seed"
theia = Agent(
    name="theia", 
    seed=SEED, 
    endpoint=["http://127.0.0.1:8003/submit"],
    port=8003,
    mailbox=False
)

@theia.on_message(model=ScreenshotTask)
async def analyze(ctx: Context, sender: str, msg: ScreenshotTask):
    try:
        ctx.logger.info(f"Received {msg.step_info} screenshot for analysis")

        prompt = [
            """
            Input: A base64-encoded browser screenshot from the current step in a task sequence.

            Task: Describe what happened in this step or what is visible on the screen in a natural, conversational first-person phrase as if you performed the action yourself.

            Response format: Return only the descriptive phrase without any explanations or additional text. The phrase should be clear, concise, and suitable for voice output.

            Examples:
            - "I opened Amazon's homepage"
            - "I typed 'keyboards' into the search bar"
            - "I clicked the search button"
            - "I'm looking at search results for keyboards"
            - "I clicked on the wireless keyboard listing"
            - "I added the item to my cart"

            Important: Only provide a new description if the current screenshot shows a different step or state from the previous one. If the screenshot appears to be identical to the last one processed, do not generate a new description to avoid repetition.

            Note: If consecutive but different screenshots show similar views with minimal changes, describe what is newly visible on the page rather than repeating the previous action.
            """
        ]

        raw = base64.b64decode(msg.image)
        buf = BytesIO(raw)
        file_ref = genai.upload_file(path=buf, mime_type="image/png")
        prompt.append(file_ref)

        resp = model.generate_content(prompt)
        analysis = resp.text.strip()
        ctx.logger.info(f"Detected actions: {analysis}")

       
        
        # Initialize analysis_history if it doesn't exist
        if not hasattr(theia, 'analysis_history'):
            theia.analysis_history = []
            
        # Only send response if this analysis is new
        if analysis not in theia.analysis_history:
            await ctx.send(HERMES_ADDRESS, Response(text=analysis, agent_address=HERMES_ADDRESS))
         # Store analysis in global array

        theia.analysis_history.append(analysis)

    except Exception as e:
        ctx.logger.error(f"Error in analyze: {e}")

if __name__ == "__main__":
    print(f"Starting Vision Agent (theia) on port 8003...")
    print(f"Agent address: {theia.address}")
    print(f"Listening at: http://127.0.0.1:8003/submit")
    print(f"Make sure browser agent is configured to use this local endpoint")
    theia.run()
