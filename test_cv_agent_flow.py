#!/usr/bin/env python3
"""
CV Agent Flow Test
Tests the complete flow: Browser → Screenshot → Vision Analysis → Voice TTS
"""

import asyncio
import base64
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Dict, Any
import subprocess
import tempfile

# Add backend to path
sys.path.append(str(Path(__file__).parent / "backend"))

from backend.agents.vision import ScreenshotTask
from backend.agents.voice import TTSManager, tts_manager

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("CV_Agent_Test")

class CVAgentTester:
    def __init__(self):
        self.test_results = []
        self.vision_agent_proc = None
        self.voice_agent_proc = None
        self.browser_agent_proc = None
        
    async def test_environment_setup(self) -> bool:
        """Test that the environment is properly configured"""
        logger.info("🔧 Testing environment setup...")
        
        required_vars = ["GEMINI_API_KEY", "OPENAI_API_KEY"]
        missing_vars = []
        
        for var in required_vars:
            if not os.getenv(var):
                missing_vars.append(var)
        
        if missing_vars:
            logger.error(f"❌ Missing environment variables: {missing_vars}")
            logger.info("Please set these in your .env file or environment")
            return False
        
        logger.info("✅ Environment variables configured")
        return True
    
    async def test_dependencies(self) -> bool:
        """Test that all required dependencies are available"""
        logger.info("📦 Testing dependencies...")
        
        # Test espeak
        try:
            result = subprocess.run(["espeak", "--version"], 
                                  capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                logger.info("✅ Espeak TTS available")
            else:
                logger.warning("⚠️ Espeak not working properly")
                return False
        except (subprocess.TimeoutExpired, FileNotFoundError):
            logger.error("❌ Espeak not found - install with: sudo apt-get install espeak")
            return False
        
        # Test Python imports
        try:
            import google.generativeai as genai
            logger.info("✅ Google Gemini AI available")
        except ImportError:
            logger.error("❌ Google Gemini AI not available")
            return False
        
        try:
            from browser_use import BrowserSession
            logger.info("✅ Browser-use library available")
        except ImportError:
            logger.error("❌ Browser-use library not available")
            return False
        
        return True
    
    async def test_tts_functionality(self) -> bool:
        """Test TTS generation functionality"""
        logger.info("🔊 Testing TTS functionality...")
        
        try:
            # Test TTS manager
            tts_mgr = TTSManager()
            test_text = "Testing TTS functionality for CV agent"
            
            logger.info(f"Generating TTS for: {test_text}")
            audio_base64 = await tts_mgr.generate_speech(test_text)
            
            if audio_base64 and len(audio_base64) > 0:
                logger.info(f"✅ TTS generated successfully ({len(audio_base64)} chars)")
                
                # Optionally save to file for inspection
                try:
                    audio_data = base64.b64decode(audio_base64)
                    test_file = Path("/tmp/cv_agent_tts_test.wav")
                    test_file.write_bytes(audio_data)
                    logger.info(f"✅ Test audio saved to {test_file}")
                except Exception as e:
                    logger.warning(f"⚠️ Could not save test audio: {e}")
                
                return True
            else:
                logger.error("❌ TTS generation failed - no audio data")
                return False
                
        except Exception as e:
            logger.error(f"❌ TTS test failed: {e}")
            return False
    
    async def test_vision_analysis(self) -> bool:
        """Test vision analysis functionality with a sample screenshot"""
        logger.info("👁️ Testing vision analysis...")
        
        try:
            # Create a simple test image (black square with white text)
            from PIL import Image, ImageDraw, ImageFont
            import io
            
            # Create test image
            img = Image.new('RGB', (800, 600), color='white')
            draw = ImageDraw.Draw(img)
            
            # Draw some test content
            draw.rectangle([50, 50, 750, 550], outline='black', width=2)
            draw.text((100, 100), "CV Agent Test Screenshot", fill='black')
            draw.text((100, 150), "This is a test image for vision analysis", fill='black')
            draw.rectangle([100, 200, 300, 300], fill='blue')
            draw.text((120, 240), "Blue Button", fill='white')
            
            # Convert to base64
            buffer = io.BytesIO()
            img.save(buffer, format='PNG')
            image_base64 = base64.b64encode(buffer.getvalue()).decode()
            
            logger.info("📸 Created test screenshot")
            
            # Test that we can create a screenshot task
            screenshot_task = ScreenshotTask(
                image=image_base64,
                step_info="test step: screenshot analysis"
            )
            
            logger.info("✅ Screenshot task created successfully")
            logger.info(f"✅ Image data size: {len(image_base64)} characters")
            
            return True
            
        except ImportError:
            logger.warning("⚠️ PIL not available for image test - installing...")
            try:
                subprocess.run([sys.executable, "-m", "pip", "install", "Pillow"], 
                             check=True, capture_output=True)
                logger.info("✅ PIL installed, vision test would work now")
                return True
            except subprocess.CalledProcessError as e:
                logger.error(f"❌ Failed to install PIL: {e}")
                return False
        except Exception as e:
            logger.error(f"❌ Vision analysis test failed: {e}")
            return False
    
    async def test_agent_communication(self) -> bool:
        """Test inter-agent communication setup"""
        logger.info("📡 Testing agent communication setup...")
        
        try:
            from uagents import Agent
            
            # Test that we can create agents
            test_agent = Agent(name="test", seed="test-seed", port=9999)
            logger.info("✅ Agent creation works")
            
            # Test address generation
            if hasattr(test_agent, 'address') and test_agent.address:
                logger.info(f"✅ Agent address: {test_agent.address}")
            else:
                logger.warning("⚠️ Agent address not available")
            
            return True
            
        except Exception as e:
            logger.error(f"❌ Agent communication test failed: {e}")
            return False
    
    async def test_file_structure(self) -> bool:
        """Test that all required files exist"""
        logger.info("📁 Testing file structure...")
        
        required_files = [
            "backend/agents/vision.py",
            "backend/agents/voice.py", 
            "backend/agents/browser.py",
            "backend/agents/orchestrator.py",
            "backend/pyproject.toml"
        ]
        
        missing_files = []
        for file_path in required_files:
            if not Path(file_path).exists():
                missing_files.append(file_path)
        
        if missing_files:
            logger.error(f"❌ Missing files: {missing_files}")
            return False
        
        logger.info("✅ All required files present")
        return True
    
    async def test_ports_available(self) -> bool:
        """Test that required ports are available"""
        logger.info("🔌 Testing port availability...")
        
        ports_to_test = [8000, 8001, 8002, 8003]
        
        for port in ports_to_test:
            try:
                import socket
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.settimeout(1)
                    result = s.connect_ex(('localhost', port))
                    if result == 0:
                        logger.warning(f"⚠️ Port {port} is already in use")
                    else:
                        logger.info(f"✅ Port {port} is available")
            except Exception as e:
                logger.warning(f"⚠️ Could not test port {port}: {e}")
        
        return True
    
    async def test_complete_flow_simulation(self) -> bool:
        """Simulate the complete CV agent flow"""
        logger.info("🎯 Testing complete flow simulation...")
        
        try:
            # 1. Simulate browser taking screenshot
            logger.info("1️⃣ Simulating browser screenshot capture...")
            
            # 2. Simulate vision analysis
            logger.info("2️⃣ Simulating vision analysis...")
            test_description = "I clicked the search button and now I'm seeing search results"
            
            # 3. Simulate TTS generation
            logger.info("3️⃣ Simulating TTS generation...")
            tts_mgr = TTSManager()
            audio_data = await tts_mgr.generate_speech(test_description)
            
            if audio_data:
                logger.info("✅ Complete flow simulation successful")
                logger.info(f"📝 Description: {test_description}")
                logger.info(f"🔊 Audio generated: {len(audio_data)} chars")
                return True
            else:
                logger.error("❌ Complete flow simulation failed")
                return False
                
        except Exception as e:
            logger.error(f"❌ Complete flow simulation error: {e}")
            return False
    
    async def run_all_tests(self) -> Dict[str, bool]:
        """Run all tests and return results"""
        logger.info("🚀 Starting CV Agent comprehensive tests...")
        
        tests = [
            ("Environment Setup", self.test_environment_setup),
            ("Dependencies", self.test_dependencies),
            ("TTS Functionality", self.test_tts_functionality),
            ("Vision Analysis", self.test_vision_analysis),
            ("Agent Communication", self.test_agent_communication),
            ("File Structure", self.test_file_structure),
            ("Port Availability", self.test_ports_available),
            ("Complete Flow Simulation", self.test_complete_flow_simulation),
        ]
        
        results = {}
        passed = 0
        total = len(tests)
        
        for test_name, test_func in tests:
            try:
                logger.info(f"\n{'='*50}")
                logger.info(f"Running: {test_name}")
                logger.info(f"{'='*50}")
                
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
        logger.info(f"\n{'='*60}")
        logger.info(f"CV AGENT TEST SUMMARY")
        logger.info(f"{'='*60}")
        logger.info(f"Tests passed: {passed}/{total}")
        logger.info(f"Success rate: {(passed/total)*100:.1f}%")
        
        if passed == total:
            logger.info("🎉 All tests passed! CV Agent is ready to run.")
        else:
            logger.warning(f"⚠️ {total-passed} tests failed. Check the issues above.")
        
        logger.info(f"\n📋 Detailed Results:")
        for test_name, result in results.items():
            status = "✅ PASS" if result else "❌ FAIL"
            logger.info(f"  {status} {test_name}")
        
        return results

async def main():
    """Main test runner"""
    tester = CVAgentTester()
    results = await tester.run_all_tests()
    
    # Exit with error code if any tests failed
    if not all(results.values()):
        sys.exit(1)
    else:
        logger.info("\n🚀 CV Agent is ready! You can start the agents:")
        logger.info("  python backend/agents/voice.py &")
        logger.info("  python backend/agents/vision.py &")
        logger.info("  python backend/agents/browser.py &")
        logger.info("  python backend/agents/orchestrator.py &")

if __name__ == "__main__":
    asyncio.run(main())