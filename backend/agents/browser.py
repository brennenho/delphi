import os

from browser_use import Agent as BrowserAgent
from browser_use import BrowserSession
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
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

browser_session = BrowserSession(
    # Path to a specific Chromium-based executable (optional)
    executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',  # macOS
    # For Windows: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    # For Linux: '/usr/bin/google-chrome'
    
    # Use a specific data directory on disk (optional, set to None for incognito)
    user_data_dir=None,   # this is the default
    # ... any other BrowserProfile or playwright launch_persistnet_context config...
    # headless=False,
    keep_alive=True,
    window_size={"width": 10000, "height": 10000},
)

@uagent.on_message(model=BrowserTask, replies=BrowserResult)
async def handle_browser_task(ctx: Context, sender: str, req: BrowserTask):
    await browser_session.start()
    
    llm = ChatOpenAI(model="gpt-4o-mini")
    agent = BrowserAgent(task=req.task, llm=llm, browser_session=browser_session)

    # step_counter = 0

    # async def on_step_end(agent_instance):
    #     nonlocal step_counter
    #     step_counter += 1

    #     raw = await agent_instance.browser_context.take_screenshot()
    #     if isinstance(raw, str) and raw.startswith("data:image"):
    #         b64 = raw.split(",", 1)[1]
    #     elif isinstance(raw, str):
    #         b64 = raw
    #     else:
    #         b64 = base64.b64encode(raw).decode("utf-8")

    #     msg = ScreenshotTask(
    #         image=b64,
    #         step_info=f"step {step_counter}"
    #     )

    #     await ctx.send(
    #         VISION_AGENT_ADDRESS,
    #         msg
    #     )

    # result = await agent.run(on_step_end=on_step_end)
    # print(result)
    
    # result = await agent.run(on_step_end=on_step_end)
    result = await agent.run()
    
    final_extracted_content = result.final_result() if result else "No content extracted"
    
    reply = BrowserResult(
        status="done",
        detail=final_extracted_content
    )

    await ctx.send(sender, reply)

    await browser_session.close()

if __name__ == "__main__":
    uagent.run()