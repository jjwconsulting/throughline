"""Veeva Vault Direct Data API client — minimal, retry-aware.

Three operations we need: authenticate, list extracts, download a filepart.
Hand-rolled instead of pulling in VAPIL because (a) Direct Data is a tiny
surface area, (b) VAPIL's Python story is rough, and (c) we want full
control over retry, error messages, and dependency footprint.

Used from Fabric notebooks. Inline-paste or import via %run depending on
how Fabric's library management is set up. The whole file is self-contained;
no relative imports.

Reference: https://developer.veevavault.com/api/25.1/#retrieve-direct-data-files
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Literal

import requests

log = logging.getLogger(__name__)


ExtractType = Literal["full_directdata", "incremental_directdata", "log_directdata"]


@dataclass(frozen=True)
class FilepartDetail:
    filepart: int
    name: str            # e.g., '292905-20260308-0500-F.001'
    size: int            # bytes
    url: str | None = None  # download URL if Veeva provides one inline


@dataclass(frozen=True)
class DirectDataExtract:
    name: str            # e.g., '292905-20260308-0500-F'
    extract_type: str    # 'full_directdata' or 'incremental_directdata'
    start_time: str      # 'YYYY-MM-DDTHH:MMZ'
    stop_time: str
    record_count: int
    fileparts: int
    size: int            # bytes (sum of all parts)
    filename: str | None = None
    filepart_details: tuple[FilepartDetail, ...] = ()


class VeevaAuthError(Exception):
    pass


class VeevaApiError(Exception):
    pass


class VeevaDirectData:
    """Veeva Direct Data API client.

    Auth uses session-based login (POST /auth). The session ID is reused for
    subsequent calls. If it expires, the client re-authenticates automatically
    on the next call. Retries on transient failures (5xx, connection errors)
    with exponential backoff.
    """

    def __init__(
        self,
        vault_dns: str,
        username: str,
        password: str,
        api_version: str = "v25.1",
        max_retries: int = 3,
        timeout_seconds: int = 60,
    ):
        self.vault_dns = vault_dns
        self.api_version = api_version
        self._username = username
        self._password = password
        self._session_id: str | None = None
        self._max_retries = max_retries
        self._timeout = timeout_seconds
        self._base_url = f"https://{vault_dns}/api/{api_version}"

    # ----- Auth -----

    def authenticate(self) -> None:
        url = f"{self._base_url}/auth"
        body = {"username": self._username, "password": self._password}

        last_err: Exception | None = None
        for attempt in range(self._max_retries):
            try:
                r = requests.post(url, data=body, timeout=self._timeout)
                data = r.json()
                if data.get("responseStatus") != "SUCCESS":
                    raise VeevaAuthError(f"Auth failed: {data}")
                self._session_id = data["sessionId"]
                log.info("Authenticated to %s as %s", self.vault_dns, self._username)
                return
            except (requests.RequestException, ValueError) as e:
                last_err = e
                wait = 2 ** attempt
                log.warning("Auth attempt %d failed: %s — retrying in %ds", attempt + 1, e, wait)
                time.sleep(wait)
        raise VeevaAuthError(f"Authentication exhausted retries: {last_err}")

    # ----- Internal request helper -----

    def _request(self, method: str, path: str, **kwargs) -> requests.Response:
        if self._session_id is None:
            self.authenticate()

        url = f"{self._base_url}{path}"
        headers = {**kwargs.pop("headers", {}), "Authorization": self._session_id or ""}
        kwargs.setdefault("timeout", self._timeout)

        last_err: Exception | None = None
        for attempt in range(self._max_retries):
            try:
                r = requests.request(method, url, headers=headers, **kwargs)
                # Veeva returns 200 for INVALID_SESSION_ID errors with the body
                # carrying the error code. Catch and re-auth.
                if r.status_code == 200 and "application/json" in r.headers.get("content-type", ""):
                    body = r.json()
                    if isinstance(body, dict) and body.get("responseStatus") == "FAILURE":
                        errors = body.get("errors", [])
                        if any(e.get("type") == "INVALID_SESSION_ID" for e in errors):
                            log.info("Session expired, re-authenticating")
                            self._session_id = None
                            self.authenticate()
                            headers["Authorization"] = self._session_id or ""
                            continue
                if r.status_code >= 500 or r.status_code == 429:
                    raise VeevaApiError(f"{method} {url} -> {r.status_code} {r.text[:200]}")
                return r
            except (requests.RequestException, VeevaApiError) as e:
                last_err = e
                wait = 2 ** attempt
                log.warning("%s %s attempt %d failed: %s — retrying in %ds",
                            method, path, attempt + 1, e, wait)
                time.sleep(wait)
        raise VeevaApiError(f"{method} {path} exhausted retries: {last_err}")

    # ----- Direct Data: list -----

    def list_extracts(
        self,
        extract_type: ExtractType,
        start_time: str,
        stop_time: str,
    ) -> list[DirectDataExtract]:
        """List Direct Data extracts available in [start_time, stop_time].

        Times are 'YYYY-MM-DDTHH:MMZ' UTC (15-min increments per Veeva spec).
        Returns extracts sorted by stop_time ascending. Empty list if none.
        """
        params = {"extract_type": extract_type, "start_time": start_time, "stop_time": stop_time}
        r = self._request("GET", "/services/directdata/files", params=params)
        body = r.json()
        if body.get("responseStatus") != "SUCCESS":
            raise VeevaApiError(f"list_extracts failed: {body}")

        out: list[DirectDataExtract] = []
        for item in body.get("data", []) or []:
            parts = tuple(
                FilepartDetail(
                    filepart=int(p.get("filepart", 1)),
                    name=p.get("name", ""),
                    size=int(p.get("size", 0)),
                    url=p.get("url"),
                )
                for p in (item.get("filepart_details") or [])
            )
            out.append(
                DirectDataExtract(
                    name=item.get("name", ""),
                    extract_type=item.get("extract_type", extract_type),
                    start_time=item.get("start_time", ""),
                    stop_time=item.get("stop_time", ""),
                    record_count=int(item.get("record_count", 0)),
                    fileparts=int(item.get("fileparts", 1)),
                    size=int(item.get("size", 0)),
                    filename=item.get("filename"),
                    filepart_details=parts,
                )
            )
        out.sort(key=lambda x: x.stop_time)
        return out

    # ----- Direct Data: download -----

    def download_filepart(self, filepart_name: str) -> bytes:
        """Download one filepart by its name, e.g. '292905-20260308-0500-F.001'.

        Returns the raw .tar.gz bytes. For multi-part extracts, call once per
        filepart_details entry and concatenate in part order.
        """
        r = self._request(
            "GET",
            f"/services/directdata/files/{filepart_name}",
            stream=False,  # for large files we'd stream; keep simple for now
        )
        if r.status_code != 200:
            raise VeevaApiError(f"download_filepart {filepart_name} -> {r.status_code}")
        return r.content

    def download_extract(self, extract: DirectDataExtract) -> bytes:
        """Download a full extract (handles multi-part transparently).

        Returns the concatenated .tar.gz bytes ready to write to disk + extract.
        For very large extracts (>1GB), prefer streaming part-by-part to disk
        instead of holding all bytes in memory.
        """
        if not extract.filepart_details:
            # Some Veeva responses don't enumerate parts when fileparts=1
            return self.download_filepart(f"{extract.name}.001")

        chunks: list[bytes] = []
        for part in sorted(extract.filepart_details, key=lambda p: p.filepart):
            log.info("Downloading filepart %d of %s (%d bytes)",
                     part.filepart, extract.name, part.size)
            chunks.append(self.download_filepart(part.name))
        return b"".join(chunks)
