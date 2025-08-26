import os
import base64
import asyncio

from browser_use import Agent as BrowserAgent
from browser_use import Browser, BrowserConfig
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from uagents import Agent as UAgent
from uagents import Context, Model

load_dotenv()
SEED = os.getenv("BROWSER_SEED", "athena-default-seed")
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
    port=int(os.getenv("BROWSER_PORT", 8001)),
)

# Improved browser configuration
browser_config = BrowserConfig(
    headless=os.getenv("HEADLESS", "false").lower() == "true",
    disable_security=True,  # For automation
    
    # Additional browser arguments for better automation
    extra_chromium_args=[
        "--no-sandbox",
        "--disable-dev-shm-usage", 
        "--disable-blink-features=AutomationControlled",
        "--disable-extensions",
        "--no-first-run",
        "--disable-default-apps",
        "--disable-popup-blocking",
        f"--window-size={os.getenv('WINDOW_WIDTH', '1920')},{os.getenv('WINDOW_HEIGHT', '1080')}"
    ]
)

# Create browser instance
browser = Browser(config=browser_config)

@uagent.on_message(model=BrowserTask, replies=BrowserResult)
async def handle_browser_task(ctx: Context, sender: str, req: BrowserTask):
    try:
        ctx.logger.info(f"Starting browser task: {req.task}")
        
        llm = ChatOpenAI(model="gpt-4o-mini", api_key=os.getenv("OPENAI_API_KEY"))
        agent = BrowserAgent(task=req.task, llm=llm, browser=browser)

        step_counter = 0
        last_screenshot_hash = None

        async def on_step_end(agent_instance):
            nonlocal step_counter, last_screenshot_hash
            step_counter += 1

            try:
                # Take screenshot after each step
                raw = await agent_instance.browser.take_screenshot()
                if isinstance(raw, str) and raw.startswith("data:image"):
                    b64 = raw.split(",", 1)[1]
                elif isinstance(raw, str):
                    b64 = raw
                else:
                    b64 = base64.b64encode(raw).decode("utf-8")

                # Simple deduplication check
                import hashlib
                screenshot_hash = hashlib.md5(b64.encode()).hexdigest()
                
                if screenshot_hash != last_screenshot_hash:
                    last_screenshot_hash = screenshot_hash
                    
                    msg = ScreenshotTask(
                        image=b64,
                        step_info=f"step {step_counter}: {agent_instance.last_action or 'action completed'}"
                    )

                    # Send screenshot to vision agent
                    if VISION_AGENT_ADDRESS:
                        await ctx.send(VISION_AGENT_ADDRESS, msg)
                        ctx.logger.info(f"Screenshot sent to vision agent for step {step_counter}")
                    else:
                        ctx.logger.warning("VISION_AGENT_ADDRESS not set, cannot send screenshot")
                else:
                    ctx.logger.info(f"Skipping duplicate screenshot for step {step_counter}")
                    
            except Exception as e:
                ctx.logger.error(f"Error taking/sending screenshot: {e}")

        # Run the browser automation with screenshot callback  
        result = await agent.run(on_step_end=on_step_end)
        
        final_extracted_content = result.final_result() if result else "No content extracted"
        
        reply = BrowserResult(
            status="completed",
            detail=final_extracted_content
        )

        await ctx.send(sender, reply)
        ctx.logger.info(f"Browser task completed: {final_extracted_content}")

    except Exception as e:
        ctx.logger.error(f"Error in browser task: {e}")
        reply = BrowserResult(
            status="error",
            detail=f"Browser task failed: {str(e)}"
        )
        await ctx.send(sender, reply)
    
    finally:
        try:
            await browser.close()
            ctx.logger.info("Browser closed")
        except Exception as e:
            ctx.logger.error(f"Error closing browser: {e}")

if __name__ == "__main__":
    uagent.run()