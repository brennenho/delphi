import base64
import os
import hashlib
import time
import logging
from io import BytesIO

import google.generativeai as genai
from dotenv import load_dotenv
from uagents import Agent, Context, Model

load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("Theia-Vision")

class ScreenshotTask(Model):
    image: str
    step_info: str

class Response(Model):
    text: str
    agent_address: str

class VisionDescription(Model):
    description: str
    timestamp: float
    step_info: str

genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
model = genai.GenerativeModel("gemini-1.5-pro")

HERMES_ADDRESS = os.getenv("HERMES_ADDRESS", "agent1qfpqn9jhvp8w6ka6wkqkz9bx7h8hmrkn3wfq7zu4lcttn8nthrx4eyzd6t4")

SEED = "theia-random-secure-seed"
theia = Agent(
    name="theia", 
    seed=SEED, 
    endpoint=["http://127.0.0.1:8003/submit"],
    port=int(os.getenv("VISION_PORT", 8003)),
    mailbox=False
)

# Global state for tracking screenshots and descriptions
screenshot_history = []
analysis_history = []
last_description_time = 0

# Performance monitoring
performance_stats = {
    "total_screenshots": 0,
    "processed_screenshots": 0,
    "skipped_duplicates": 0,
    "total_processing_time": 0,
    "average_processing_time": 0,
    "vision_api_calls": 0,
    "vision_api_time": 0,
    "last_update": 0,
    "descriptions_sent": 0,
    "errors": 0
}

# Enhanced logging for monitoring
def log_performance_metrics():
    """Log detailed performance metrics"""
    current_time = time.time()
    if current_time - performance_stats["last_update"] > 30:  # Log every 30 seconds
        logger.info("="*60)
        logger.info("VISION AGENT PERFORMANCE METRICS")
        logger.info("="*60)
        logger.info(f"Total Screenshots Received: {performance_stats['total_screenshots']}")
        logger.info(f"Screenshots Processed: {performance_stats['processed_screenshots']}")
        logger.info(f"Duplicates Skipped: {performance_stats['skipped_duplicates']}")
        logger.info(f"Descriptions Sent: {performance_stats['descriptions_sent']}")
        logger.info(f"Errors: {performance_stats['errors']}")
        logger.info(f"Vision API Calls: {performance_stats['vision_api_calls']}")
        
        if performance_stats['processed_screenshots'] > 0:
            logger.info(f"Average Processing Time: {performance_stats['average_processing_time']:.2f}s")
            avg_api_time = performance_stats['vision_api_time'] / performance_stats['vision_api_calls']
            logger.info(f"Average API Response Time: {avg_api_time:.2f}s")
            
        processing_rate = performance_stats['processed_screenshots'] / performance_stats['total_screenshots'] * 100 if performance_stats['total_screenshots'] > 0 else 0
        logger.info(f"Processing Rate: {processing_rate:.1f}%")
        logger.info("="*60)
        
        performance_stats["last_update"] = current_time

def compute_image_hash(image_data: str) -> str:
    """Compute hash of image data for deduplication"""
    return hashlib.md5(image_data.encode()).hexdigest()

def is_duplicate_screenshot(image_hash: str) -> bool:
    """Check if this screenshot is a duplicate of recent ones"""
    return image_hash in screenshot_history[-3:]  # Check last 3 screenshots

def should_generate_description(analysis: str) -> bool:
    """Determine if we should generate a new description"""
    global last_description_time
    
    # Avoid identical descriptions within 2 seconds
    current_time = time.time()
    if current_time - last_description_time < 2:
        logger.debug(f"Skipping description due to time threshold: {analysis}")
        return False
    
    # Check if analysis is too similar to recent ones
    for recent_analysis in analysis_history[-2:]:
        if analysis.lower().strip() == recent_analysis.lower().strip():
            logger.debug(f"Skipping duplicate analysis: {analysis}")
            return False
    
    # Filter out generic or unhelpful responses
    unhelpful_phrases = [
        "loading", "please wait", "no change", "same as before", 
        "similar to previous", "unchanged", "identical"
    ]
    
    if any(phrase in analysis.lower() for phrase in unhelpful_phrases):
        logger.debug(f"Skipping unhelpful analysis: {analysis}")
        return False
    
    return True

def update_performance_stats(processing_time: float, api_time: float, was_processed: bool):
    """Update performance statistics"""
    global performance_stats
    
    performance_stats["total_screenshots"] += 1
    if was_processed:
        performance_stats["processed_screenshots"] += 1
        performance_stats["total_processing_time"] += processing_time
        performance_stats["average_processing_time"] = (
            performance_stats["total_processing_time"] / performance_stats["processed_screenshots"]
        )
        performance_stats["vision_api_calls"] += 1
        performance_stats["vision_api_time"] += api_time
    else:
        performance_stats["skipped_duplicates"] += 1
    
    # Log stats every 10 screenshots
    if performance_stats["total_screenshots"] % 10 == 0:
        logger.info(f"Performance Stats: {performance_stats}")

@theia.on_message(model=ScreenshotTask)
async def analyze(ctx: Context, sender: str, msg: ScreenshotTask):
    start_time = time.time()
    api_start_time = 0
    api_end_time = 0
    was_processed = False
    
    try:
        logger.info(f"Received {msg.step_info} screenshot for analysis")
        
        # Compute image hash for deduplication
        image_hash = compute_image_hash(msg.image)
        
        # Skip if this is a duplicate screenshot
        if is_duplicate_screenshot(image_hash):
            logger.info(f"Skipping duplicate screenshot for {msg.step_info}")
            return
        
        # Add to history
        screenshot_history.append(image_hash)
        if len(screenshot_history) > 10:  # Keep only last 10 hashes
            screenshot_history.pop(0)

        prompt = [
            """
            You are analyzing a browser screenshot during automated web navigation. Your job is to describe what just happened in this step in a natural, conversational way as if you performed the action yourself.

            Guidelines:
            1. Use first-person language ("I clicked", "I typed", "I see")
            2. Be specific about what action was performed or what changed
            3. Focus on the most significant element or action visible
            4. Keep descriptions concise but informative (1-2 sentences max)
            5. Only describe meaningful changes or actions, not static content
            6. If the page is loading or unchanged, say "I'm waiting for the page to load"

            Examples of good descriptions:
            - "I clicked the search button and now I'm seeing search results"
            - "I typed 'wireless headphones' in the search box"
            - "I clicked on the first product listing"
            - "I added the item to my shopping cart"
            - "I'm navigating to the checkout page"
            - "I filled in my email address in the login form"

            Respond with ONLY the description, nothing else.
            """
        ]

        # Process the image
        try:
            logger.debug(f"Processing image for {msg.step_info}")
            raw = base64.b64decode(msg.image)
            buf = BytesIO(raw)
            file_ref = genai.upload_file(path=buf, mime_type="image/png")
            prompt.append(file_ref)

            # Measure API call time
            api_start_time = time.time()
            resp = model.generate_content(prompt)
            api_end_time = time.time()
            
            analysis = resp.text.strip()
            was_processed = True
            
            logger.info(f"Generated analysis ({api_end_time - api_start_time:.2f}s): {analysis}")

            # Check if we should send this description
            if should_generate_description(analysis):
                global last_description_time
                last_description_time = time.time()
                
                # Store analysis in history
                analysis_history.append(analysis)
                if len(analysis_history) > 5:  # Keep only last 5 analyses
                    analysis_history.pop(0)
                
                # Create response for voice agent
                vision_description = VisionDescription(
                    description=analysis,
                    timestamp=last_description_time,
                    step_info=msg.step_info
                )
                
                # Send to voice agent
                await ctx.send(HERMES_ADDRESS, Response(
                    text=analysis, 
                    agent_address=ctx.agent.address
                ))
                
                performance_stats["descriptions_sent"] += 1
                logger.info(f"Sent description to voice agent: {analysis}")
            else:
                logger.info(f"Skipped sending duplicate/similar analysis: {analysis}")

        except Exception as upload_error:
            logger.error(f"Error processing image: {upload_error}")
            performance_stats["errors"] += 1
            
    except Exception as e:
        logger.error(f"Error in analyze: {e}")
        performance_stats["errors"] += 1
    
    finally:
        # Update performance stats
        end_time = time.time()
        processing_time = end_time - start_time
        api_time = api_end_time - api_start_time if api_start_time > 0 else 0
        update_performance_stats(processing_time, api_time, was_processed)
        
        # Log performance metrics periodically
        log_performance_metrics()

if __name__ == "__main__":
    logger.info(f"Theia Vision Agent starting on port {theia.port}")
    logger.info(f"Hermes address: {HERMES_ADDRESS}")
    theia.run()
