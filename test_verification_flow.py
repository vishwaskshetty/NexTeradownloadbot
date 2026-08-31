import unittest
from unittest.mock import MagicMock, patch

from verification_error import VerificationError
from resolver import TeraBoxResolver, is_verification_required
from worker import Worker, Job


class TestVerificationFlow(unittest.TestCase):

    def test_verification_error_class(self):
        err = VerificationError("Verification required", errno=400310, session_id="test_123")
        self.assertEqual(err.message, "Verification required")
        self.assertEqual(err.errno, 400310)
        self.assertEqual(err.code, 400310)
        self.assertEqual(err.session_id, "test_123")

    def test_is_verification_required(self):
        # 1. VerificationError instance
        self.assertTrue(is_verification_required(VerificationError("verify")))

        # 2. Exception with errno 400310
        class ErrnoError(Exception):
            errno = 400310
        self.assertTrue(is_verification_required(ErrnoError()))

        # 3. Exception with code 400310
        class CodeError(Exception):
            code = 400310
        self.assertTrue(is_verification_required(CodeError()))

        # 4. Exception with verify_v2 in message
        self.assertTrue(is_verification_required(Exception("need verify_v2 token")))

        # 5. Generic exception
        self.assertFalse(is_verification_required(Exception("normal network failure")))

    def test_resolver_stops_cascade_on_verification_error(self):
        strat1 = MagicMock(side_effect=VerificationError("need verify_v2"))
        strat2 = MagicMock(return_value="should_not_reach_here")

        resolver = TeraBoxResolver(strategies=[strat1, strat2])

        with self.assertRaises(VerificationError):
            resolver.resolve("http://terabox.com/s/12345")

        strat1.assert_called_once()
        strat2.assert_not_called()

    @patch.object(Worker, "_http_get")
    @patch.object(Worker, "_http_post")
    def test_worker_handle_verification_required_verified(self, mock_post, mock_get):
        # Mock session creation API POST
        mock_post.return_value = {"success": True}

        # Mock status polling API GET: first pending, then verified
        mock_get.side_effect = [
            {"status": "pending"},
            {"status": "verified"}
        ]

        # Resolver mock
        resolver = MagicMock()
        # First call raises VerificationError, second call returns link
        resolver.resolve.side_effect = [
            VerificationError("need verify_v2"),
            "https://download.terabox.com/file.mp4"
        ]

        bot = MagicMock()
        worker = Worker(resolver=resolver, bot=bot)
        job = Job(job_id="job_001", url="https://terabox.com/s/test", chat_id=123456)

        with patch("worker.time.sleep", return_value=None):
            result = worker.process_job(job)

        self.assertEqual(job.status, "completed")
        self.assertEqual(result, "https://download.terabox.com/file.mp4")
        self.assertEqual(resolver.resolve.call_count, 2)
        bot.send_message.assert_called()


if __name__ == "__main__":
    unittest.main()
