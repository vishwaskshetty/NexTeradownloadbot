import unittest
from unittest.mock import MagicMock, patch

from verification_error import VerificationError
from resolver import TeraBoxResolver, is_verification_required
from worker import Worker, Job


class TestAdvancedResolver(unittest.TestCase):

    def test_dict_return_triggering_verification(self):
        # Case 1: Strategy returns a dictionary with status=400310 instead of raising an exception
        strat1 = MagicMock(return_value={"status": 400310, "message": "need verify_v2 token"})
        strat2 = MagicMock(return_value="should_not_be_called")

        resolver = TeraBoxResolver(strategies=[strat1, strat2])

        with self.assertRaises(VerificationError):
            resolver.resolve("https://terabox.com/s/12345")

        strat1.assert_called_once()
        strat2.assert_not_called()

    def test_wrapped_nested_cause_verification(self):
        # Case 2: Strategy raises a wrapped generic error with __cause__ set to VerificationError
        inner_err = VerificationError("inner verify_v2")
        wrapper_err = RuntimeError("gateway strategy failed")
        wrapper_err.__cause__ = inner_err

        strat1 = MagicMock(side_effect=wrapper_err)
        strat2 = MagicMock(return_value="should_not_be_called")

        resolver = TeraBoxResolver(strategies=[strat1, strat2])

        with self.assertRaises(VerificationError):
            resolver.resolve("https://terabox.com/s/12345")

        strat1.assert_called_once()
        strat2.assert_not_called()

    def test_http_response_json_verification(self):
        # Case 3: Strategy raises an HTTPError with .response.json() containing errno 400310
        class HTTPError(Exception):
            pass

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"errno": 400310, "errmsg": "need verify_v2"}

        http_err = HTTPError("400 Bad Request")
        http_err.response = mock_resp

        strat1 = MagicMock(side_effect=http_err)
        strat2 = MagicMock(return_value="should_not_be_called")

        resolver = TeraBoxResolver(strategies=[strat1, strat2])

        with self.assertRaises(VerificationError):
            resolver.resolve("https://terabox.com/s/12345")

        strat1.assert_called_once()
        strat2.assert_not_called()


if __name__ == "__main__":
    unittest.main()
