import asyncio
import unittest
from unittest.mock import MagicMock, AsyncMock, patch

from verification_error import VerificationError
from resolver import TeraBoxResolver
from worker_async import AsyncWorker, Job


class TestAsyncVerificationFlow(unittest.TestCase):

    def test_async_handle_verification_required(self):
        async def run_test():
            resolver = MagicMock()
            resolver.resolve.side_effect = [
                VerificationError("need verify_v2"),
                "https://download.terabox.com/file.mp4"
            ]

            bot = MagicMock()
            bot.send_message = AsyncMock()

            worker = AsyncWorker(resolver=resolver, bot=bot)
            job = Job(job_id="job_async_001", url="https://terabox.com/s/test", chat_id=987654)

            with patch.object(AsyncWorker, "_send_bot_message", new_callable=AsyncMock) as mock_msg:
                with patch("aiohttp.ClientSession") as mock_session_cls:
                    # Mock POST session response
                    mock_post_ctx = AsyncMock()
                    mock_post_resp = AsyncMock()
                    mock_post_resp.status = 200
                    mock_post_ctx.__aenter__.return_value = mock_post_resp

                    # Mock GET status response: first pending, then verified
                    mock_get_pending_ctx = AsyncMock()
                    mock_get_pending_resp = AsyncMock()
                    mock_get_pending_resp.status = 200
                    mock_get_pending_resp.json.return_value = {"status": "pending"}
                    mock_get_pending_ctx.__aenter__.return_value = mock_get_pending_resp

                    mock_get_verified_ctx = AsyncMock()
                    mock_get_verified_resp = AsyncMock()
                    mock_get_verified_resp.status = 200
                    mock_get_verified_resp.json.return_value = {"status": "verified"}
                    mock_get_verified_ctx.__aenter__.return_value = mock_get_verified_resp

                    # Session mock instance
                    session_mock = MagicMock()
                    session_mock.post.return_value = mock_post_ctx
                    session_mock.get.side_effect = [mock_get_pending_ctx, mock_get_verified_ctx]

                    session_cls_ctx = AsyncMock()
                    session_cls_ctx.__aenter__.return_value = session_mock
                    mock_session_cls.return_value = session_cls_ctx

                    with patch("asyncio.sleep", return_value=None):
                        result = await worker.handleRequest(job)

                    self.assertEqual(job.status, "completed")
                    self.assertEqual(result, "https://download.terabox.com/file.mp4")

        asyncio.run(run_test())


if __name__ == "__main__":
    unittest.main()
