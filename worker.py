"""Worker de execucao unica para consultas publicas no Google, pensado para
rodar via GitHub Actions (cron) contra o Postgres do Supabase.

Nao tenta resolver CAPTCHA, contornar bloqueios nem automatizar navegadores. Se o
Google bloquear a requisicao, o trabalho e marcado como falho para revisao.

Variaveis de ambiente esperadas:
    SUPABASE_DB_URL  -- connection string do Postgres do projeto Supabase
                        (Dashboard > Settings > Database > Connection string > URI)
"""

from __future__ import annotations

import os
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

import psycopg2
import psycopg2.extras


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


def get_connection():
    database_url = os.environ["SUPABASE_DB_URL"]
    return psycopg2.connect(database_url)


def claim_next_job(connection) -> dict | None:
    """Pega o proximo job 'queued', marca como 'running' e retorna id + full_name.

    FOR UPDATE SKIP LOCKED evita corrida caso duas execucoes se sobreponham.
    """
    with connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
        cursor.execute(
            """
            UPDATE research_requests
            SET status = 'running'
            WHERE id = (
                SELECT id FROM research_requests
                WHERE status = 'queued'
                ORDER BY created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING id, full_name;
            """
        )
        row = cursor.fetchone()
        connection.commit()
        return row


def complete_job(connection, job_id: int, results: list[dict[str, str]]) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE research_requests
            SET status = 'completed',
                result_count = %s,
                results = %s,
                error_message = NULL
            WHERE id = %s;
            """,
            (len(results), psycopg2.extras.Json(results), job_id),
        )
        connection.commit()


def fail_job(connection, job_id: int, message: str) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE research_requests
            SET status = 'failed',
                error_message = %s
            WHERE id = %s;
            """,
            (message, job_id),
        )
        connection.commit()


def process_all_pending() -> None:
    connection = get_connection()
    try:
        processed = 0
        while True:
            job = claim_next_job(connection)
            if job is None:
                break
            processed += 1
            try:
                if not job["full_name"]:
                    raise RuntimeError("A pesquisa no Google requer o nome completo.")
                results = search_google(job["full_name"])
                complete_job(connection, job["id"], results)
                print(f"[ok] job {job['id']} concluido com {len(results)} resultado(s).")
            except RuntimeError as error:
                fail_job(connection, job["id"], str(error))
                print(f"[falhou] job {job['id']}: {error}")
        if processed == 0:
            print("Nenhuma pesquisa pendente.")
    finally:
        connection.close()


if __name__ == "__main__":
    process_all_pending()