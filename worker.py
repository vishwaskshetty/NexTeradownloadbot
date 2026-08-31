import logging
import os
import random
import time
try:
    import requests
except ImportError:
    requests = None
import urllib.request
import urllib.error
import json
from typing import Any, Optional

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


class Worker:
    """
    Main job worker processing download requests.
    """

    def __init__(self, resolver: Optional[TeraBoxResolver] = None, bot: Optional[Any] = None):
        self.resolver = resolver or TeraBoxResolver()
        self.bot = bot  # Instance with bot.send_message(chat_id, text)

    def handleRequest(self, job: Job):
        """
        Main job handling method.
        Attempts to resolve TeraBox links. Catches verification errors and triggers verification flow.
        """
        try:
            logger.info(f"[Job Worker] Starting processing for job {job.job_id} ({job.url})")
            download_data = self.resolver.resolve(job.url)
            
            # Send download link to user
            self.bot.send_message(
                job.chat_id,
                f"✅ Download ready!\n\nLink: {download_data}"
            )
            job.mark_completed(download_data)
            return download_data

        except Exception as error:
            # Check for TeraBox verification requirement (errno 400310 / verify_v2 / VerificationError)
            err_msg = getattr(error, 'message', str(error))
            errno = getattr(error, 'errno', getattr(error, 'code', None))

            if is_verification_required(error) or errno == 400310 or "verify_v2" in str(err_msg):
                logger.warning(f"[Job Worker] Verification required for job {job.job_id}. Triggering verification flow.")
                return self.handle_verification_required(job)
            else:
                # Generic error failure handling
                logger.error(f"[Job Worker] Job failed with error: {error}")
                job.mark_failed(str(error))
                if self.bot:
                    self.bot.send_message(job.chat_id, f"❌ Download failed: {error}")
                return None

    def process_job(self, job: Job):
        """Alias for handleRequest."""
        return self.handleRequest(job)

    def _http_post(self, url: str, payload: dict, timeout: int = 10) -> dict:
        if requests is not None:
            res = requests.post(url, json=payload, timeout=timeout)
            res.raise_for_status()
            return res.json() if res.content else {}
        else:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=timeout) as response:
                body = response.read().decode('utf-8')
                return json.loads(body) if body else {}

    def _http_get(self, url: str, timeout: int = 10) -> dict:
        if requests is not None:
            res = requests.get(url, timeout=timeout)
            if res.status_code == 200:
                return res.json()
            return {"status": "unknown"}
        else:
            try:
                req = urllib.request.Request(url, method='GET')
                with urllib.request.urlopen(req, timeout=timeout) as response:
                    if response.status == 200:
                        body = response.read().decode('utf-8')
                        return json.loads(body) if body else {}
                    return {"status": "unknown"}
            except Exception:
                return {"status": "error"}

    def handle_verification_required(self, job: Job):
        """
        Handles TeraBox verification workflow:
        1. Generates session_id
        2. Logs session_received
        3. POSTs session to gateway API
        4. Logs user_prompt_sent
        5. Sends Telegram message with verification link
        6. Logs polling_started
        7. Polls status every 5 seconds (max 120 times = 10 minutes)
           - On 'verified': requests completion, retries resolution, sends download link, returns success.
           - On 'rejected' / 'failed': logs failure, notifies user, returns failure.
        8. On timeout: notifies user, marks job failed, returns failure.
        """
        # Step 1: Generate session_id
        session_id = f"verify_{int(time.time())}_{random.randint(1000, 9999)}"

        # Step 2: Log session_received
        logger.info("[TeraBox Verification] session_received")

        # Step 3: POST to gateway API
        create_session_url = f"{TERABOX_GATEWAY_URL}/api/verification/session"
        try:
            self._http_post(create_session_url, payload={"session_id": session_id, "url": job.url}, timeout=10)
        except Exception as err:
            logger.error(f"[TeraBox Verification] Failed to create verification session: {err}")
            job.mark_failed(f"Failed to initiate verification session: {err}")
            if self.bot:
                self.bot.send_message(job.chat_id, "❌ Unable to start verification session. Please try again later.")
            return None

        # Step 4: Log user_prompt_sent
        logger.info("[TeraBox Verification] user_prompt_sent")

        # Step 5: Send Telegram message with verification link
        verification_url = f"{TERABOX_GATEWAY_PUBLIC_URL}/verification/{session_id}"
        prompt_text = f"🔐 TeraBox Verification Required\n\nClick here: {verification_url}"
        if self.bot:
            self.bot.send_message(job.chat_id, prompt_text)

        # Step 6: Log polling_started
        logger.info("[TeraBox Verification] polling_started")

        # Step 7: Poll every 5 seconds (max 120 times = 10 minutes)
        status_url = f"{TERABOX_GATEWAY_URL}/api/verification/session/{session_id}/status"
        max_attempts = 120
        poll_interval = 5

        for attempt in range(1, max_attempts + 1):
            time.sleep(poll_interval)
            data = self._http_get(status_url, timeout=10)
            status = data.get("status", "unknown")

            # Log status state
            logger.info(f"[TeraBox Verification] state={status}")

            if status == "verified":
                logger.info("[TeraBox Verification] completion_requested")
                try:
                    # Retry resolution after verification
                    resolved_data = self.resolver.resolve(job.url, session_id=session_id)
                    logger.info("[TeraBox Verification] direct_resolution_success")

                    # Send download to user
                    if self.bot:
                        self.bot.send_message(
                            job.chat_id,
                            f"✅ Verification successful! Here is your download link:\n\n{resolved_data}"
                        )
                    job.mark_completed(resolved_data)
                    return resolved_data
                except Exception as retry_err:
                    logger.error(f"[TeraBox Verification] Resolution failed post-verification: {retry_err}")
                    job.mark_failed(f"Resolution failed after verification: {retry_err}")
                    if self.bot:
                        self.bot.send_message(job.chat_id, f"❌ Download failed even after verification: {retry_err}")
                    return None

            elif status in ("rejected", "failed"):
                logger.warning(f"[TeraBox Verification] Verification session {session_id} ended with state: {status}")
                if self.bot:
                    self.bot.send_message(
                        job.chat_id,
                        "❌ TeraBox verification was rejected or failed. Please try again."
                    )
                job.mark_failed(f"Verification {status}")
                return None

        # Step 8: On timeout (120 attempts reached)
        logger.warning(f"[TeraBox Verification] Session {session_id} timed out after {max_attempts} attempts.")
        if self.bot:
            self.bot.send_message(
                job.chat_id,
                "⏳ TeraBox verification timed out after 10 minutes. Please try downloading again."
            )
        job.mark_failed("Verification timeout")
        return None
