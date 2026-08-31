"""
TeraBox Link Resolver Module with Deep Verification Error Inspection.
"""

import logging
from typing import Any, Callable, Dict, List, Optional
from verification_error import VerificationError

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def is_verification_required(error: Exception) -> bool:
    """
    Deep inspection function to determine if an error requires TeraBox verification.
    
    Checks across multiple potential error layers:
    1. Direct instance check for VerificationError
    2. Direct attributes (error.errno, error.code)
    3. Error string, message attribute, and args
    4. HTTP response JSON body (if error has .response attribute from requests/httpx/aiohttp)
    5. Nested exception causes (__cause__ or __context__)
    """
    if error is None:
        return False

    logger.info(f"[Debug] Inspecting error type={type(error).__name__}, repr={error!r}")

    # 1. Direct instance check
    if isinstance(error, VerificationError):
        logger.info("[Debug] MATCH: Direct VerificationError instance")
        return True

    # 2. Direct attribute checks (errno == 400310 or code == 400310)
    errno = getattr(error, 'errno', None)
    if errno == 400310:
        logger.info("[Debug] MATCH: getattr(error, 'errno') == 400310")
        return True

    code = getattr(error, 'code', None)
    if code == 400310:
        logger.info("[Debug] MATCH: getattr(error, 'code') == 400310")
        return True

    # 3. String searches in error representation, message attribute, and args
    err_str = str(error)
    err_msg = str(getattr(error, 'message', ''))
    err_args = str(getattr(error, 'args', ()))

    keywords = ["verify_v2", "400310", "PROVIDER_VERIFICATION_REQUIRED", "need verify_v2"]
    for kw in keywords:
        if kw in err_str or kw in err_msg or kw in err_args:
            logger.info(f"[Debug] MATCH: Found verification keyword '{kw}' in error text")
            return True

    # 4. HTTP response JSON inspection (e.g. requests.HTTPError, httpx.HTTPStatusError, etc.)
    response = getattr(error, 'response', None)
    if response is not None:
        try:
            # Handle methods vs dicts for response.json
            json_data = None
            if callable(getattr(response, 'json', None)):
                json_data = response.json()
            elif isinstance(getattr(response, 'json', None), dict):
                json_data = response.json

            if isinstance(json_data, dict):
                resp_errno = json_data.get('errno') or json_data.get('code')
                resp_str = str(json_data)
                if resp_errno == 400310 or any(kw in resp_str for kw in keywords):
                    logger.info(f"[Debug] MATCH: Found verification requirement in error.response.json(): {json_data}")
                    return True
        except Exception as json_err:
            logger.debug(f"[Debug] Could not parse error.response.json(): {json_err}")

    # 5. Check nested exception causes (__cause__ or __context__)
    for cause in (getattr(error, '__cause__', None), getattr(error, '__context__', None)):
        if cause is not None and cause is not error:
            if is_verification_required(cause):
                logger.info(f"[Debug] MATCH: Found verification in nested cause '{type(cause).__name__}'")
                return True

    logger.info("[Debug] NO MATCH: Regular error, continuing cascade")
    return False


class TeraBoxResolver:
    """
    Resolver for TeraBox links with fallback strategy cascade.
    Stops immediately if a strategy raises a verification error (errno 400310 / verify_v2)
    or returns a dictionary indicating verification is required.
    """

    def __init__(self, strategies: Optional[List[Callable]] = None):
        self.strategies = strategies or [
            self._strategy_gateway,
            self._strategy_seiya,
            self._strategy_terabox_api,
            self._strategy_hrishi,
            self._strategy_itz,
        ]

    def is_verification_required(self, error: Exception) -> bool:
        """
        Instance method wrapper for deep verification inspection.
        """
        return is_verification_required(error)

    def resolve(self, url: str, session_id: Optional[str] = None) -> Any:
        """
        Attempts to resolve TeraBox download link across multiple strategies.
        If a strategy raises a verification error or returns a verification dictionary,
        stops the fallback strategy cascade immediately.
        """
        last_exception = None

        for strategy in self.strategies:
            strategy_name = getattr(strategy, '__name__', str(strategy))
            try:
                logger.info(f"[TeraBox Resolver] Attempting strategy: {strategy_name}")
                result = strategy(url, session_id=session_id)

                # CHECK: What if the strategy returned a verification dict instead of raising an exception?
                if isinstance(result, dict):
                    status = result.get('status') or result.get('errno') or result.get('code')
                    msg = str(result.get('message') or result.get('error') or result.get('errmsg') or '')

                    keywords = ["verify_v2", "400310", "PROVIDER_VERIFICATION_REQUIRED"]
                    if status == 400310 or any(kw in msg for kw in keywords):
                        logger.warning(
                            f"[TeraBox Resolver] Strategy '{strategy_name}' returned verification dict - converting to VerificationError"
                        )
                        raise VerificationError(
                            message=msg or "PROVIDER_VERIFICATION_REQUIRED",
                            errno=400310,
                            session_id=session_id
                        )

                return result

            except Exception as error:
                last_exception = error

                logger.info(f"[TeraBox Resolver Debug] Strategy '{strategy_name}' raised {type(error).__name__}: {error!r}")

                # Deep inspection to detect verification error
                if self.is_verification_required(error):
                    logger.warning("[TeraBox Resolver] PROVIDER_VERIFICATION_REQUIRED (errno=400310) - STOPPING CASCADE")
                    if not isinstance(error, VerificationError):
                        raise VerificationError(
                            message=str(getattr(error, 'message', error)),
                            errno=getattr(error, 'errno', getattr(error, 'code', 400310)),
                            session_id=session_id,
                        ) from error
                    raise error

                logger.warning(f"[TeraBox Resolver] {strategy_name}: LINK_RESOLUTION_FAILED ({error})")
                continue

        if last_exception:
            raise last_exception
        raise Exception("All TeraBox resolution strategies failed.")

    # ── Strategy Placeholders ──────────────────────────────────────────

    def _strategy_gateway(self, url: str, session_id: Optional[str] = None):
        pass

    def _strategy_seiya(self, url: str, session_id: Optional[str] = None):
        pass

    def _strategy_terabox_api(self, url: str, session_id: Optional[str] = None):
        pass

    def _strategy_hrishi(self, url: str, session_id: Optional[str] = None):
        pass

    def _strategy_itz(self, url: str, session_id: Optional[str] = None):
        pass
