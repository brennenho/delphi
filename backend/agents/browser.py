import base64
import os

from browser_use import Agent as BrowserAgent
from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
from uagents import Agent as UAgent
from uagents import Context, Model

load_dotenv()
SEED = os.getenv("BROWSER_SEED")
VISION_AGENT_ADDRESS = os.getenv("VISION_AGENT_ADDRESS")

class BrowserTask(Model):
    task: str

class BrowserResult(Model):
    status: str
    detail: str

class ScreenshotTask(Model):
    image: str
    step_info: str

uagent = UAgent(
    name="Athena",
    seed=SEED,
    mailbox=True,
    port=8001,
)

# browser_protocol = Protocol(name="BrowserProtocol", version="1.0")
# screenshot_protocol = Protocol(name="ScreenshotProtocol", version="1.0")

@uagent.on_message(model=BrowserTask, replies=BrowserResult)
async def handle_browser_task(ctx: Context, sender: str, req: BrowserTask):
    llm   = ChatGoogleGenerativeAI(model="gemini-2.0-flash-exp")
    agent = BrowserAgent(task=req.task, llm=llm)

    step_counter = 0

    async def on_step_end(agent_instance):
        nonlocal step_counter
        step_counter += 1

        raw = await agent_instance.browser_context.take_screenshot()
        if isinstance(raw, str) and raw.startswith("data:image"):
            b64 = raw.split(",", 1)[1]
        elif isinstance(raw, str):
            b64 = raw
        else:
            b64 = base64.b64encode(raw).decode("utf-8")

        msg = ScreenshotTask(
            image=b64,
            step_info=f"step {step_counter}"
        )

        await ctx.send(
            VISION_AGENT_ADDRESS,
            msg
        )

    # result = await agent.run(on_step_end=on_step_end)
    # print(result)
    
    try:
        result = await agent.run(on_step_end=on_step_end)
        
        final_extracted_content = result.final_result() if result else "No content extracted"
        
        reply = BrowserResult(
            status="done",
            detail=final_extracted_content
        )
    except Exception as e:
        reply = BrowserResult(
            status="error",
            detail=str(e)
        )
    await ctx.send(sender, reply)

if __name__ == "__main__":
    uagent.run()
