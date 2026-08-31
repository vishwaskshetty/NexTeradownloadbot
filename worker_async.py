import asyncio
import logging
import os
import random
import time
from typing import Any, Optional

try:
    import aiohttp
except ImportError:
    aiohttp = None

try:
    import httpx
except ImportError:
    httpx = None

from resolver import TeraBoxResolver, is_verification_required
from verification_error import VerificationError

logger = logging.getLogger(__name__)

# Environment variable configuration
TERABOX_GATEWAY_URL = os.getenv(
    "TERABOX_GATEWAY_URL",
    "http://terabox-gateway-nex.railway.internal:8080"
).rstrip('/')

TERABOX_GATEWAY_PUBLIC_URL = os.getenv(
    "TERABOX_GATEWAY_PUBLIC_URL",
    "https://terabox-gateway-nex-production.up.railway.app"
).rstrip('/')


class Job:
    """
    Representation of a Telegram download job.
    """
    def __init__(self, job_id: str, url: str, chat_id: int):
        self.job_id = job_id
        self.url = url
        self.chat_id = chat_id
        self.status = "pending"
        self.result = None
        self.error = None

    def mark_failed(self, reason: str):
        self.status = "failed"
        self.error = reason
        logger.error(f"[Job Worker] Job {self.job_id} marked failed: {reason}")

    def mark_completed(self, result: Any):
        self.status = "completed"
        self.result = result
        logger.info(f"[Job Worker] Job {self.job_id} completed successfully.")


class AsyncWorker:
    """
    Async job worker processing TeraBox download requests with asyncio.
    """

    def __init__(self, resolver: Optional[Any] = None, bot: Optional[Any] = None):
        self.resolver = resolver or TeraBoxResolver()
        self.bot = bot  # Telegram bot instance (e.g. python-telegram-bot / aiogram)

    async def _send_bot_message(self, chat_id: int, text: str):
        """Helper to send telegram message whether bot method is sync or async."""
        if not self.bot:
            return
        if hasattr(self.bot, "send_message"):
            res = self.bot.send_message(chat_id=chat_id, text=text)
            if asyncio.iscoroutine(res):
                await res
        elif callable(self.bot):
            res = self.bot(chat_id, text)
            if asyncio.iscoroutine(res):
                await res

    async def handleRequest(self, job: Job):
        """
        Main async job handling method.
        """
        try:
            logger.info(f"[Job Worker] Starting processing for job {job.job_id} ({job.url})")
            
            # Resolve URL (handle sync or async resolver)
            if asyncio.iscoroutinefunction(getattr(self.resolver, "resolve", None)):
                download_data = await self.resolver.resolve(job.url)
            else:
                download_data = await asyncio.to_thread(self.resolver.resolve, job.url)

            await self._send_bot_message(
                job.chat_id,
                f"✅ Download ready!\n\nLink: {download_data}"
            )
            job.mark_completed(download_data)
            return download_data

        except Exception as error:
            err_msg = getattr(error, 'message', str(error))
            errno = getattr(error, 'errno', getattr(error, 'code', None))

            if is_verification_required(error) or errno == 400310 or "verify_v2" in str(err_msg):
                logger.warning(f"[Job Worker] Verification required for job {job.job_id}. Triggering verification flow.")
                return await self.handle_verification_required(job)
            else:
                logger.error(f"[Job Worker] Job failed with error: {error}")
                job.mark_failed(str(error))
                await self._send_bot_message(job.chat_id, f"❌ Download failed: {error}")
                return None

    async def process_job(self, job: Job):
        """Alias for handleRequest."""
        return await self.handleRequest(job)

    async def handle_verification_required(self, job: Job):
        """
        Asynchronous TeraBox verification handler using asyncio and aiohttp / httpx.
        """
        # Step 1: Generate session_id
        session_id = f"verify_{int(time.time())}_{random.randint(1000, 9999)}"

        # Step 2: Log session_received
        logger.info("[TeraBox Verification] session_received")

        # Step 3: POST to gateway API (non-blocking)
        create_session_url = f"{TERABOX_GATEWAY_URL}/api/verification/session"
        payload = {"session_id": session_id, "url": job.url}

        try:
            if aiohttp is not None:
                async with aiohttp.ClientSession() as session:
                    async with session.post(create_session_url, json=payload, timeout=10) as resp:
                        resp.raise_for_status()
            elif httpx is not None:
                async with httpx.AsyncClient() as client:
                    resp = await client.post(create_session_url, json=payload, timeout=10)
                    resp.raise_for_status()
            else:
                raise RuntimeError("Neither aiohttp nor httpx is installed.")
        except Exception as err:
            logger.error(f"[TeraBox Verification] Failed to create verification session: {err}")
            job.mark_failed(f"Failed to initiate verification session: {err}")
            await self._send_bot_message(job.chat_id, "❌ Unable to start verification session. Please try again later.")
            return None

        # Step 4: Log user_prompt_sent
        logger.info("[TeraBox Verification] user_prompt_sent")

        # Step 5: Send Telegram message with verification link
        verification_url = f"{TERABOX_GATEWAY_PUBLIC_URL}/verification/{session_id}"
        prompt_text = f"🔐 TeraBox Verification Required\n\nClick here: {verification_url}"
        await self._send_bot_message(job.chat_id, prompt_text)

        # Step 6: Log polling_started
        logger.info("[TeraBox Verification] polling_started")

        # Step 7: Poll every 5 seconds (max 120 times = 10 minutes)
        status_url = f"{TERABOX_GATEWAY_URL}/api/verification/session/{session_id}/status"
        max_attempts = 120
        poll_interval = 5

        for attempt in range(1, max_attempts + 1):
            await asyncio.sleep(poll_interval)
            status = "unknown"

            try:
                if aiohttp is not None:
                    async with aiohttp.ClientSession() as session:
                        async with session.get(status_url, timeout=10) as resp:
                            if resp.status == 200:
                                data = await resp.json()
                                status = data.get("status", "pending")
                elif httpx is not None:
                    async with httpx.AsyncClient() as client:
                        resp = await client.get(status_url, timeout=10)
                        if resp.status_code == 200:
                            data = resp.json()
                            status = data.get("status", "pending")
            except Exception as req_err:
                logger.warning(f"[TeraBox Verification] Polling check failed on attempt {attempt}: {req_err}")
                status = "error"

            # Log status state
            logger.info(f"[TeraBox Verification] state={status}")

            if status == "verified":
                logger.info("[TeraBox Verification] completion_requested")
                try:
                    # Retry resolution after verification
                    if asyncio.iscoroutinefunction(getattr(self.resolver, "resolve", None)):
                        resolved_data = await self.resolver.resolve(job.url, session_id=session_id)
                    else:
                        resolved_data = await asyncio.to_thread(self.resolver.resolve, job.url, session_id=session_id)

                    logger.info("[TeraBox Verification] direct_resolution_success")

                    # Send download link to user
                    await self._send_bot_message(
                        job.chat_id,
                        f"✅ Verification successful! Here is your download link:\n\n{resolved_data}"
                    )
                    job.mark_completed(resolved_data)
                    return resolved_data
                except Exception as retry_err:
                    logger.error(f"[TeraBox Verification] Resolution failed post-verification: {retry_err}")
                    job.mark_failed(f"Resolution failed after verification: {retry_err}")
                    await self._send_bot_message(
                        job.chat_id,
                        f"❌ Download failed even after verification: {retry_err}"
                    )
                    return None

            elif status in ("rejected", "failed"):
                logger.warning(f"[TeraBox Verification] Verification session {session_id} ended with state: {status}")
                await self._send_bot_message(
                    job.chat_id,
                    "❌ TeraBox verification was rejected or failed. Please try again."
                )
                job.mark_failed(f"Verification {status}")
                return None

        # Step 8: On timeout (120 attempts reached)
        logger.warning(f"[TeraBox Verification] Session {session_id} timed out after {max_attempts} attempts.")
        await self._send_bot_message(
            job.chat_id,
            "⏳ TeraBox verification timed out after 10 minutes. Please try downloading again."
        )
        job.mark_failed("Verification timeout")
        return None
