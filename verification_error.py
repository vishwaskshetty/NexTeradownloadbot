from typing import Optional


class VerificationError(Exception):
    """
    Custom exception raised when TeraBox requires user verification (errno 400310 / verify_v2).

    Attributes:
        message (str): Detailed error message.
        errno (int): Error code associated with verification (default: 400310).
        session_id (Optional[str]): Verification session ID if available.
    """

    def __init__(
        self,
        message: str,
        errno: int = 400310,
        session_id: Optional[str] = None
    ) -> None:
        super().__init__(message)
        self.message: str = message
        self.errno: int = errno
        self.code: int = errno  # Property alias for code attribute compatibility
        self.session_id: Optional[str] = session_id

    def __str__(self) -> str:
        return self.message

    def __repr__(self) -> str:
        return f"VerificationError(message={self.message!r}, errno={self.errno!r}, session_id={self.session_id!r})"
