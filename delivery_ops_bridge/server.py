from __future__ import annotations

import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict

from .adapters.feishu import FeishuAdapter
from .adapters.tapd import TapdAdapter
from .config import load_config
from .services.dashboard import DashboardService
from .services.message_handler import MessageHandler
from .storage import JsonStore


def build_handler(config_path: str | None = None, dry_run: bool = False) -> MessageHandler:
    config = load_config(config_path)
    store = JsonStore(config.data_path)
    feishu = FeishuAdapter(config.feishu, dry_run=dry_run)
    tapd = TapdAdapter(config.tapd, dry_run=dry_run)
    dashboard = DashboardService(
        store=store,
        data_dir=config.data_path,
        project_name=config.project.name,
        group_name=config.feishu.group_name,
        public_base_url=config.runtime.public_base_url,
    )
    return MessageHandler(config, store, feishu, tapd, dashboard)


class DeliveryOpsRequestHandler(BaseHTTPRequestHandler):
    bridge: MessageHandler

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._json_response(200, {"ok": True})
            return
        self._json_response(404, {"error": "not_found"})

    def do_POST(self) -> None:
        try:
            payload = self._read_json()
        except json.JSONDecodeError:
            self._json_response(400, {"error": "invalid_json"})
            return

        if payload.get("type") == "url_verification":
            self._json_response(200, {"challenge": payload.get("challenge", "")})
            return

        verify_token = self.bridge.config.feishu.verify_token
        if verify_token and not hmac.compare_digest(str(payload.get("token", "")), verify_token):
            self._json_response(403, {"error": "invalid_verify_token"})
            return

        try:
            result = self.bridge.handle_event(payload)
            self._json_response(200, result)
        except Exception as exc:
            self.bridge.store.append_audit_log("handler_error", {"error": str(exc)})
            self._json_response(500, {"error": str(exc)})

    def _read_json(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        return json.loads(body.decode("utf-8"))

    def _json_response(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run_server(config_path: str | None = None, host: str = "0.0.0.0", port: int | None = None, dry_run: bool = False) -> None:
    handler = build_handler(config_path, dry_run=dry_run)
    DeliveryOpsRequestHandler.bridge = handler
    server = ThreadingHTTPServer((host, port or int(os.environ.get("PORT", "8080"))), DeliveryOpsRequestHandler)
    print(f"Delivery Ops Bridge listening on http://{host}:{server.server_port}")
    server.serve_forever()
