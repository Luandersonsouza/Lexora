"""Servidor local para o portal Lexora.

Execute com: python server.py
O banco SQLite e criado automaticamente em ./data/lexora.db.
"""

from __future__ import annotations

import argparse
import json
import secrets
import sqlite3
from datetime import UTC, datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from worker import ResearchWorker

ROOT = Path(__file__).resolve().parent
DATABASE_PATH = ROOT / "data" / "lexora.db"
HOST = "127.0.0.1"
PORT = 8080
research_worker: ResearchWorker | None = None


def timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database() -> None:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS research_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                full_name TEXT,
                document_id TEXT,
                state TEXT,
                keyword TEXT,
                status TEXT NOT NULL DEFAULT 'queued',
                attempts INTEGER NOT NULL DEFAULT 0,
                result_count INTEGER NOT NULL DEFAULT 0,
                results_json TEXT NOT NULL DEFAULT '[]',
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS user_profile (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                name TEXT NOT NULL,
                email TEXT NOT NULL,
                role TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            INSERT OR IGNORE INTO user_profile (id, name, email, role, updated_at)
            VALUES (1, 'Alex Martins', 'admin@lexora.com.br', 'Administrador', ?)
            """,
            (timestamp(),),
        )
        existing_columns = {row["name"] for row in connection.execute("PRAGMA table_info(research_requests)")}
        migrations = {
            "attempts": "INTEGER NOT NULL DEFAULT 0",
            "result_count": "INTEGER NOT NULL DEFAULT 0",
            "results_json": "TEXT NOT NULL DEFAULT '[]'",
            "error_message": "TEXT",
            "is_saved": "INTEGER NOT NULL DEFAULT 0",
        }
        for column, definition in migrations.items():
            if column not in existing_columns:
                connection.execute(f"ALTER TABLE research_requests ADD COLUMN {column} {definition}")
        connection.execute(
            """
            UPDATE research_requests
            SET status = 'failed',
                error_message = 'A versao anterior nao conseguiu extrair links do Google.',
                updated_at = ?
            WHERE status = 'completed'
              AND result_count = 0
              AND results_json = '[]'
              AND error_message IS NULL
            """,
            (timestamp(),),
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_research_requests_created_at "
            "ON research_requests(created_at DESC)"
        )


def serialize_request(row: sqlite3.Row) -> dict[str, object]:
    try:
        results = json.loads(row["results_json"] or "[]")
    except json.JSONDecodeError:
        results = []
    return {
        "id": row["id"],
        "source": row["source"],
        "fullName": row["full_name"],
        "documentId": row["document_id"],
        "state": row["state"],
        "keyword": row["keyword"],
        "status": row["status"],
        "attempts": row["attempts"],
        "resultCount": row["result_count"],
        "results": results,
        "errorMessage": row["error_message"],
        "isSaved": bool(row["is_saved"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def serialize_profile(row: sqlite3.Row) -> dict[str, str]:
    return {"name": row["name"], "email": row["email"], "role": row["role"]}


class LexoraHandler(SimpleHTTPRequestHandler):
    """Serve os arquivos estaticos e a API local no mesmo endereco."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def send_json(self, payload: dict[str, object], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self) -> dict[str, object] | None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length > 16_384:
                raise ValueError("Corpo da solicitacao excede o limite permitido.")
            raw_body = self.rfile.read(content_length)
            return json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            return None

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        body = self.read_json_body()
        if body is None:
            self.send_json({"error": "Envie um JSON valido."}, HTTPStatus.BAD_REQUEST)
            return
        if path == "/api/auth/login":
            self.login(body)
            return
        if path == "/api/researches":
            self.create_research(body)
            return
        if path.startswith("/api/researches/") and path.endswith("/save"):
            self.set_saved(path.split("/")[-2], body)
            return
        self.send_json({"error": "Rota nao encontrada."}, HTTPStatus.NOT_FOUND)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json({"status": "ok", "database": str(DATABASE_PATH)})
            return
        if path == "/api/researches":
            self.list_researches()
            return
        if path == "/api/profile":
            self.get_profile()
            return
        if path.startswith("/api/researches/"):
            self.get_research(path.rsplit("/", 1)[-1])
            return
        super().do_GET()

    def do_PUT(self) -> None:
        path = urlparse(self.path).path
        body = self.read_json_body()
        if body is None:
            self.send_json({"error": "Envie um JSON valido."}, HTTPStatus.BAD_REQUEST)
            return
        if path == "/api/profile":
            self.update_profile(body)
            return
        self.send_json({"error": "Rota nao encontrada."}, HTTPStatus.NOT_FOUND)

    def login(self, body: dict[str, object]) -> None:
        email = str(body.get("email", "")).strip()
        password = str(body.get("password", "")).strip()
        if not email or not password:
            self.send_json({"error": "Informe e-mail e senha."}, HTTPStatus.UNPROCESSABLE_ENTITY)
            return
        with connect() as connection:
            profile = connection.execute("SELECT * FROM user_profile WHERE id = 1").fetchone()
        self.send_json(
            {
                "token": secrets.token_urlsafe(24),
                "user": serialize_profile(profile),
                "mode": "demo",
            }
        )

    def create_research(self, body: dict[str, object]) -> None:
        full_name = str(body.get("fullName", "")).strip()[:160]
        document_id = "".join(character for character in str(body.get("documentId", "")) if character.isdigit())[:14]
        if not full_name:
            self.send_json(
                {"error": "Informe o nome completo para a pesquisa no Google."},
                HTTPStatus.UNPROCESSABLE_ENTITY,
            )
            return
        source = str(body.get("source", "Google")).strip()[:50] or "Google"
        state = str(body.get("state", "")).strip().upper()[:2]
        keyword = str(body.get("keyword", "")).strip()[:160]
        now = timestamp()
        with connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO research_requests
                    (source, full_name, document_id, state, keyword, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
                """,
                (source, full_name or None, document_id or None, state or None, keyword or None, now, now),
            )
            row = connection.execute(
                "SELECT * FROM research_requests WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
        self.send_json({"research": serialize_request(row)}, HTTPStatus.CREATED)
        if research_worker:
            research_worker.notify()

    def set_saved(self, raw_id: str, body: dict[str, object]) -> None:
        try:
            request_id = int(raw_id)
        except ValueError:
            self.send_json({"error": "Identificador invalido."}, HTTPStatus.BAD_REQUEST)
            return
        saved = bool(body.get("saved"))
        with connect() as connection:
            connection.execute(
                "UPDATE research_requests SET is_saved = ?, updated_at = ? WHERE id = ?",
                (int(saved), timestamp(), request_id),
            )
            row = connection.execute("SELECT * FROM research_requests WHERE id = ?", (request_id,)).fetchone()
        if row is None:
            self.send_json({"error": "Solicitacao nao encontrada."}, HTTPStatus.NOT_FOUND)
            return
        self.send_json({"research": serialize_request(row)})

    def get_profile(self) -> None:
        with connect() as connection:
            row = connection.execute("SELECT * FROM user_profile WHERE id = 1").fetchone()
        self.send_json({"profile": serialize_profile(row)})

    def update_profile(self, body: dict[str, object]) -> None:
        name = str(body.get("name", "")).strip()[:80]
        email = str(body.get("email", "")).strip()[:160]
        role = str(body.get("role", "")).strip()[:50]
        if not name or "@" not in email or not role:
            self.send_json({"error": "Informe nome, e-mail valido e funcao."}, HTTPStatus.UNPROCESSABLE_ENTITY)
            return
        with connect() as connection:
            connection.execute(
                "UPDATE user_profile SET name = ?, email = ?, role = ?, updated_at = ? WHERE id = 1",
                (name, email, role, timestamp()),
            )
            row = connection.execute("SELECT * FROM user_profile WHERE id = 1").fetchone()
        self.send_json({"profile": serialize_profile(row)})

    def list_researches(self) -> None:
        with connect() as connection:
            rows = connection.execute(
                "SELECT * FROM research_requests ORDER BY id DESC LIMIT 50"
            ).fetchall()
        self.send_json({"researches": [serialize_request(row) for row in rows]})

    def get_research(self, raw_id: str) -> None:
        try:
            request_id = int(raw_id)
        except ValueError:
            self.send_json({"error": "Identificador invalido."}, HTTPStatus.BAD_REQUEST)
            return
        with connect() as connection:
            row = connection.execute(
                "SELECT * FROM research_requests WHERE id = ?", (request_id,)
            ).fetchone()
        if row is None:
            self.send_json({"error": "Solicitacao nao encontrada."}, HTTPStatus.NOT_FOUND)
            return
        self.send_json({"research": serialize_request(row)})

    def log_message(self, format: str, *args: object) -> None:
        print(f"[{timestamp()}] {self.address_string()} {format % args}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Servidor local Lexora")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", default=PORT, type=int)
    options = parser.parse_args()
    initialize_database()
    research_worker = ResearchWorker(connect, timestamp)
    research_worker.start()
    print(f"Lexora em execucao: http://{options.host}:{options.port}")
    print(f"Banco de dados: {DATABASE_PATH}")
    ThreadingHTTPServer((options.host, options.port), LexoraHandler).serve_forever()
