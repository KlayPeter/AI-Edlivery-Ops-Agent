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

    def do_OPTIONS(self) -> None:
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._json_response(200, {"ok": True})
            return
            
        if self.path == "/api/config":
            config_path = os.environ.get("DELIVERY_OPS_CONFIG", "config/config.json")
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    self._json_response(200, json.load(f))
            except Exception as e:
                self._json_response(500, {"error": str(e)})
            return

        if self.path == "/api/dashboards":
            dashboards_dir = self.bridge.config.data_path / "dashboards"
            if not dashboards_dir.exists():
                self._json_response(200, {"dashboards": []})
                return
            files = [f.name for f in dashboards_dir.iterdir() if f.name.endswith(".html")]
            self._json_response(200, {"dashboards": sorted(files, reverse=True)})
            return
            
        if self.path.startswith("/api/dashboards/"):
            filename = self.path.split("/")[-1]
            filepath = self.bridge.config.data_path / "dashboards" / filename
            if filepath.exists() and filepath.name.endswith(".html"):
                with open(filepath, "r", encoding="utf-8") as f:
                    body = f.read().encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
                return
            self._json_response(404, {"error": "not_found"})
            return

        if self.path == "/api/logs":
            logs_path = self.bridge.config.data_path / "logs" / "audit.jsonl"
            if not logs_path.exists():
                self._json_response(200, {"logs": []})
                return
            logs = []
            try:
                with open(logs_path, "r", encoding="utf-8") as f:
                    for line in f:
                        if line.strip():
                            logs.append(json.loads(line))
            except Exception:
                pass
            self._json_response(200, {"logs": list(reversed(logs))[:100]})
            return

        self._json_response(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path == "/api/config":
            try:
                payload = self._read_json()
                config_path = os.environ.get("DELIVERY_OPS_CONFIG", "config/config.json")
                with open(config_path, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False, indent=2)
                self._json_response(200, {"ok": True})
            except Exception as e:
                self._json_response(500, {"error": str(e)})
            return

        if self.path.startswith("/api/jobs/"):
            job_name = self.path.split("/")[-1]
            valid_jobs = ["standup-push", "standup-remind", "standup-summary", "overdue-scan", "daily-summary", "dashboard"]
            if job_name in valid_jobs:
                try:
                    payload = self._read_json()
                except Exception:
                    payload = {}
                dry_run = payload.get("dryRun", False)
                try:
                    import subprocess
                    cmd = ["python3", "-m", "delivery_ops_bridge.cli", "--config", "config/config.json"]
                    if dry_run:
                        cmd.append("--dry-run")
                    cmd.extend(["job", job_name])
                    subprocess.Popen(cmd)
                    self._json_response(200, {"ok": True, "message": f"任务 {job_name} 已在后台启动"})
                except Exception as e:
                    self._json_response(500, {"error": str(e)})
            else:
                self._json_response(400, {"error": "无效的任务名称"})
            return

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
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


def run_server(config_path: str | None = None, host: str = "0.0.0.0", port: int | None = None, dry_run: bool = False) -> None:
    handler = build_handler(config_path, dry_run=dry_run)
    DeliveryOpsRequestHandler.bridge = handler
    server = ThreadingHTTPServer((host, port or int(os.environ.get("PORT", "8080"))), DeliveryOpsRequestHandler)
    print(f"Delivery Ops Bridge listening on http://{host}:{server.server_port}")
    server.serve_forever()
