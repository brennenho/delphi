#!/usr/bin/env python3
"""
CV Agent Core Functionality Test
Tests the core components without starting full agent services
"""

import asyncio
import base64
import logging
import os
import sys
from pathlib import Path

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("CV_Core_Test")

async def test_tts_functionality():
    """Test TTS functionality"""
    logger.info("🔊 Testing TTS functionality...")
    
    try:
        # Test espeak directly without importing the full voice agent
        import subprocess
        test_text = "Testing TTS functionality"
        
        # Create temporary file for audio output
        import tempfile
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
            test_text
        ]
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        await process.communicate()
        
        # Check if file was created
        if Path(temp_path).exists():
            file_size = Path(temp_path).stat().st_size
            logger.info(f"✅ TTS generated successfully ({file_size} bytes)")
            
            # Encode to base64 for testing
            with open(temp_path, "rb") as f:
                audio_data = f.read()
            audio_base64 = base64.b64encode(audio_data).decode()
            logger.info(f"✅ Audio base64 encoded ({len(audio_base64)} chars)")
            
            # Clean up
            os.unlink(temp_path)
            return True
        else:
            logger.error("❌ TTS generation failed - no output file")
            return False
            
    except Exception as e:
        logger.error(f"❌ TTS test failed: {e}")
        return False

async def test_vision_models():
    """Test vision analysis setup"""
    logger.info("👁️ Testing vision model setup...")
    
    try:
        sys.path.append(str(Path(__file__).parent / "backend"))
        from backend.agents.vision import ScreenshotTask, model
        
        # Test model configuration
        if model:
            logger.info("✅ Vision model configured")
        else:
            logger.error("❌ Vision model not configured")
            return False
        
        # Test screenshot task creation
        test_image = base64.b64encode(b"fake_image_data").decode()
        task = ScreenshotTask(
            image=test_image,
            step_info="test screenshot"
        )
        
        logger.info("✅ Screenshot task creation works")
        return True
        
    except Exception as e:
        logger.error(f"❌ Vision test failed: {e}")
        return False

async def test_browser_config():
    """Test browser configuration"""
    logger.info("🌐 Testing browser configuration...")
    
    try:
        sys.path.append(str(Path(__file__).parent / "backend"))
        from backend.agents.browser import browser, browser_config, ScreenshotTask
        
        # Test browser config
        if browser and browser_config:
            logger.info("✅ Browser configured")
            logger.info(f"  Headless: {browser_config.headless}")
            logger.info(f"  Disable security: {browser_config.disable_security}")
        else:
            logger.error("❌ Browser not configured")
            return False
        
        # Test screenshot task
        test_task = ScreenshotTask(
            image="test_image",
            step_info="test"
        )
        logger.info("✅ Browser screenshot task creation works")
        
        return True
        
    except Exception as e:
        logger.error(f"❌ Browser test failed: {e}")
        return False

async def test_environment():
    """Test environment setup"""
    logger.info("🔧 Testing environment...")
    
    # Check for required environment variables
    required_vars = ["GEMINI_API_KEY", "OPENAI_API_KEY"]
    missing = []
    
    for var in required_vars:
        if not os.getenv(var):
            missing.append(var)
    
    if missing:
        logger.warning(f"⚠️ Missing environment variables: {missing}")
        logger.info("Create a .env file with your API keys or set them in environment")
        logger.info("Example:")
        for var in missing:
            logger.info(f"  {var}=your_key_here")
        return False
    else:
        logger.info("✅ Environment variables configured")
        return True

async def test_dependencies():
    """Test dependencies"""
    logger.info("📦 Testing dependencies...")
    
    try:
        import google.generativeai as genai
        logger.info("✅ Google Gemini AI available")
    except ImportError:
        logger.error("❌ Google Gemini AI not available")
        return False
    
    try:
        from browser_use import Browser, BrowserConfig
        logger.info("✅ Browser-use library available")
    except ImportError:
        logger.error("❌ Browser-use library not available")
        return False
    
    try:
        from uagents import Agent
        logger.info("✅ uAgents library available")
    except ImportError:
        logger.error("❌ uAgents library not available")
        return False
    
    # Check espeak
    import subprocess
    try:
        result = subprocess.run(["espeak", "--version"], 
                              capture_output=True, timeout=5)
        if result.returncode == 0:
            logger.info("✅ Espeak TTS available")
        else:
            logger.warning("⚠️ Espeak not working")
            return False
    except:
        logger.error("❌ Espeak not found")
        return False
    
    return True

async def main():
    """Run all core functionality tests"""
    logger.info("🚀 Starting CV Agent Core Functionality Tests")
    logger.info("="*60)
    
    tests = [
        ("Environment Setup", test_environment),
        ("Dependencies", test_dependencies),
        ("Browser Configuration", test_browser_config),
        ("Vision Model Setup", test_vision_models),
        ("TTS Functionality", test_tts_functionality),
    ]
    
    results = {}
    passed = 0
    
    for test_name, test_func in tests:
        try:
            logger.info(f"\n--- {test_name} ---")
            result = await test_func()
            results[test_name] = result
            
            if result:
                passed += 1
                logger.info(f"✅ {test_name}: PASSED")
            else:
                logger.error(f"❌ {test_name}: FAILED")
        except Exception as e:
            logger.error(f"❌ {test_name}: ERROR - {e}")
            results[test_name] = False
    
    # Summary
    total = len(tests)
    logger.info(f"\n{'='*60}")
    logger.info(f"TEST SUMMARY")
    logger.info(f"{'='*60}")
    logger.info(f"Tests passed: {passed}/{total}")
    logger.info(f"Success rate: {(passed/total)*100:.1f}%")
    
    if passed == total:
        logger.info("🎉 All core functionality tests passed!")
        logger.info("\n🚀 CV Agent is ready! To start the system:")
        logger.info("1. Make sure your .env file has API keys")
        logger.info("2. Start the agents in separate terminals:")
        logger.info("   python backend/agents/voice.py")
        logger.info("   python backend/agents/vision.py") 
        logger.info("   python backend/agents/browser.py")
        logger.info("   python backend/agents/orchestrator.py")
        logger.info("\n🎯 Complete flow: Browser action → Screenshot → Vision analysis → Voice narration")
    else:
        logger.warning(f"⚠️ {total-passed} tests failed. Fix the issues above.")
        return 1
    
    return 0

if __name__ == "__main__":
    result = asyncio.run(main())
    sys.exit(result)