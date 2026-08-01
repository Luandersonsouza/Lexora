"""Worker local para consultas publicas no Google.

Nao tenta resolver CAPTCHA, contornar bloqueios nem automatizar navegadores. Se o
Google bloquear a requisicao, o trabalho e marcado como falho para revisao.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from html.parser import HTMLParser
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen


class GoogleResultParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.link_stack: list[str] = []
        self.title_parts: list[str] = []
        self.current_url = ""
        self.in_title = False
        self.results: list[dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "a":
            self.link_stack.append(attributes.get("href") or "")
        elif tag == "h3" and self.link_stack:
            self.in_title = True
            self.title_parts = []
            self.current_url = self.link_stack[-1]

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "h3" and self.in_title:
            self.in_title = False
            title = " ".join("".join(self.title_parts).split())
            url = normalize_google_url(self.current_url)
            if title and url and len(self.results) < 5:
                self.results.append({"title": title, "url": url})
        elif tag == "a" and self.link_stack:
            self.link_stack.pop()


def normalize_google_url(value: str) -> str:
    if value.startswith("/url?"):
        destination = parse_qs(urlparse(value).query).get("q", [""])[0]
        return destination if destination.startswith(("http://", "https://")) else ""
    if value.startswith(("http://", "https://")) and "google." not in urlparse(value).netloc:
        return value
    return ""


def search_google(name: str) -> list[dict[str, str]]:
    query = f'"{name}"'
    url = "https://www.google.com/search?" + urlencode(
        {"q": query, "num": "5", "hl": "pt-BR", "gbv": "1"}
    )
    request = Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
            ),
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        },
    )
    try:
        with urlopen(request, timeout=15) as response:
            final_url = response.geturl()
            page = response.read().decode("utf-8", errors="replace")
    except HTTPError as error:
        raise RuntimeError(f"Google recusou a consulta (HTTP {error.code}).") from error
    except URLError as error:
        raise RuntimeError("Nao foi possivel conectar ao Google.") from error

    if "/sorry/" in final_url or "captcha" in page.lower() or "unusual traffic" in page.lower():
        raise RuntimeError("O Google solicitou verificacao. A coleta automatica foi interrompida.")

    parser = GoogleResultParser()
    parser.feed(page)
    if not parser.results:
        raise RuntimeError(
            "O Google nao disponibilizou resultados processaveis para esta consulta. "
            "A solicitacao nao foi marcada como resultado vazio."
        )
    return parser.results


class ResearchWorker:
    def __init__(self, connect: Callable[[], sqlite3.Connection], timestamp: Callable[[], str]) -> None:
        self.connect = connect
        self.timestamp = timestamp
        self.wake_up = threading.Event()

    def start(self) -> None:
        threading.Thread(target=self.run, name="research-worker", daemon=True).start()

    def notify(self) -> None:
        self.wake_up.set()

    def run(self) -> None:
        while True:
            self.process_next()
            self.wake_up.wait(timeout=2)
            self.wake_up.clear()

    def process_next(self) -> None:
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM research_requests WHERE status = 'queued' ORDER BY id LIMIT 1"
            ).fetchone()
            if row is None:
                return
            now = self.timestamp()
            connection.execute(
                "UPDATE research_requests SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?",
                (now, row["id"]),
            )

        try:
            if not row["full_name"]:
                raise RuntimeError("A pesquisa no Google requer o nome completo.")
            results = search_google(row["full_name"])
            with self.connect() as connection:
                connection.execute(
                    """
                    UPDATE research_requests
                    SET status = 'completed', result_count = ?, results_json = ?, error_message = NULL, updated_at = ?
                    WHERE id = ?
                    """,
                    (len(results), json.dumps(results, ensure_ascii=False), self.timestamp(), row["id"]),
                )
        except RuntimeError as error:
            with self.connect() as connection:
                connection.execute(
                    "UPDATE research_requests SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?",
                    (str(error), self.timestamp(), row["id"]),
                )
