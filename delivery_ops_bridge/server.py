from __future__ import annotations

import hmac
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict
from urllib.parse import unquote, urlparse, parse_qsl

from .adapters.feishu import FeishuAdapter
from .adapters.llm import LLMAdapter
from .adapters.tapd import TapdAdapter
from .config import load_config, resolve_config_path, write_config
from .services.dashboard import DashboardService
from .services.message_intent import MessageIntentParser
from .services.message_handler import MessageHandler
from .storage import JsonStore

MAX_JSON_BODY_BYTES = 1024 * 1024
VALID_JOBS = {"standup-push", "standup-remind", "standup-summary", "overdue-scan", "daily-summary", "dashboard"}


class RequestBodyTooLarge(ValueError):
    pass


def build_handler(config_path: str | None = None, dry_run: bool = False) -> MessageHandler:
    config = load_config(config_path)
    store = JsonStore(config.data_path)
    feishu = FeishuAdapter(config.feishu, dry_run=dry_run)
    feishu.set_audit_callback(store.append_audit_log)
    tapd = TapdAdapter(config.tapd, dry_run=dry_run)
    llm = LLMAdapter(config.ai, dry_run=dry_run)
    intent_parser = MessageIntentParser(llm)
    dashboard = DashboardService(
        store=store,
        data_dir=config.data_path,
        project_name=config.project.name,
        group_name=config.feishu.group_name,
        public_base_url=config.runtime.public_base_url,
    )
    handler = MessageHandler(config, store, feishu, tapd, dashboard, intent_parser)
    handler.config_path = resolve_config_path(config_path)
    handler.dry_run = dry_run
    return handler


class DeliveryOpsRequestHandler(BaseHTTPRequestHandler):
    bridge: MessageHandler = None  # type: ignore
    _processed_events: Dict[str, float] = {}

    def _route_path(self) -> str:
        return urlparse(self.path).path

    def do_OPTIONS(self) -> None:
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self) -> None:
        path = self._route_path()
        if path == "/healthz":
            self._json_response(200, {"ok": True})
            return
            
        if path == "/api/config":
            config_path = self._config_path()
            try:
                with config_path.open("r", encoding="utf-8") as f:
                    self._json_response(200, json.load(f))
            except FileNotFoundError:
                self._json_response(404, {"error": "config_not_found"})
            except json.JSONDecodeError:
                self._json_response(500, {"error": "config_invalid_json"})
            except Exception as e:
                self._json_response(500, {"error": str(e)})
            return

        if path == "/api/dashboards":
            dashboards_dir = self.bridge.config.data_path / "dashboards"
            if not dashboards_dir.exists():
                self._json_response(200, {"dashboards": []})
                return
            files = [f.name for f in dashboards_dir.iterdir() if f.name.endswith(".html")]
            self._json_response(200, {"dashboards": sorted(files, reverse=True)})
            return
            
        if path.startswith("/api/dashboards/"):
            filepath = self._dashboard_path(path)
            if filepath and filepath.exists():
                with filepath.open("r", encoding="utf-8") as f:
                    html_content = f.read().encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(html_content)))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(html_content)
                return
            self._json_response(404, {"error": "not_found"})
            return

        if path == "/api/logs":
            parsed_url = urlparse(self.path)
            query_components = dict(parse_qsl(parsed_url.query))
            page = int(query_components.get("page", "1"))
            page_size = int(query_components.get("pageSize", "20"))
            event_type = query_components.get("eventType", "")
            start_date = query_components.get("startDate", "")
            end_date = query_components.get("endDate", "")
            
            logs_path = self.bridge.config.data_path / "logs" / "audit.jsonl"
            if not logs_path.exists():
                self._json_response(200, {"logs": [], "total": 0})
                return
            logs = []
            try:
                with open(logs_path, "r", encoding="utf-8") as f:
                    for line in f:
                        if line.strip():
                            item = json.loads(line)
                            
                            if event_type:
                                item_type = item.get("action") or item.get("event_type")
                                if item_type != event_type:
                                    continue
                                    
                            ts = item.get("timestamp", "")
                            if start_date and ts < start_date:
                                continue
                            if end_date and ts > end_date + "T23:59:59Z":
                                continue
                                
                            logs.append(item)
            except Exception:
                pass
            
            logs.reverse()
            total = len(logs)
            start_idx = (page - 1) * page_size
            end_idx = start_idx + page_size
            
            self._json_response(200, {
                "logs": logs[start_idx:end_idx],
                "total": total,
                "page": page,
                "pageSize": page_size
            })
            return

        if path == "/api/contexts":
            parsed_url = urlparse(self.path)
            query_components = dict(parse_qsl(parsed_url.query))
            page = int(query_components.get("page", "1"))
            page_size = int(query_components.get("pageSize", "15"))
            context_type = query_components.get("contextType", "")
            start_date = query_components.get("startDate", "")
            end_date = query_components.get("endDate", "")
            chat_type = query_components.get("chatType", "")
            
            all_contexts = self.bridge.store.list_bot_message_contexts()
            all_contexts.sort(key=lambda x: x.get("created_at", ""), reverse=True)
            
            filtered_contexts = []
            for ctx in all_contexts:
                if context_type and ctx.get("context_type") != context_type:
                    continue
                ts = ctx.get("created_at", "")
                if start_date and ts < start_date:
                    continue
                if end_date and ts > end_date + "T23:59:59Z":
                    continue
                if chat_type == "private" and not ctx.get("target_open_id"):
                    continue
                if chat_type == "group" and not ctx.get("chat_id"):
                    continue
                filtered_contexts.append(ctx)
            
            # 丰富上下文中的人员名字信息
            for ctx in filtered_contexts:
                target_id = ctx.get("target_open_id")
                if target_id:
                    member = self.bridge.config.member_by_open_id(target_id)
                    if member:
                        ctx["target_name"] = member.name
                
                chat_id = ctx.get("chat_id")
                if chat_id and not target_id:
                    if chat_id == self.bridge.config.feishu.group_chat_id:
                        ctx["chat_name"] = self.bridge.config.feishu.group_name
                    else:
                        ctx["chat_name"] = "其他群聊"
                        
            total = len(filtered_contexts)
            start_idx = (page - 1) * page_size
            end_idx = start_idx + page_size
            
            self._json_response(200, {
                "contexts": filtered_contexts[start_idx:end_idx],
                "total": total,
                "page": page,
                "pageSize": page_size
            })
            return

        if path == "/api/standups":
            parsed_url = urlparse(self.path)
            query_components = dict(parse_qsl(parsed_url.query))
            from .models import utc_now_iso
            target_date = query_components.get("date", utc_now_iso()[:10])
            
            all_members = self.bridge.config.members
            submitted_standups = self.bridge.store.list_standups(target_date)
            submitted_map = {s.get("open_id"): s for s in submitted_standups}
            
            members_data = []
            for m in all_members:
                standup_data = submitted_map.get(m.open_id)
                members_data.append({
                    "open_id": m.open_id,
                    "name": m.name,
                    "submitted": bool(standup_data),
                    "standup_content": standup_data
                })
                
            stats = {
                "total": len(all_members),
                "submitted": len(submitted_map),
                "missing": len(all_members) - len(submitted_map)
            }
            
            self._json_response(200, {
                "date": target_date,
                "stats": stats,
                "members": members_data
            })
            return

        if path == "/api/feishu/groups":
            try:
                groups = self.bridge.feishu.list_groups()
                self._json_response(200, {"groups": groups})
            except Exception as e:
                self._json_response(500, {"error": str(e)})
            return

        self._json_response(404, {"error": "not_found"})

    def do_POST(self) -> None:
        path = self._route_path()
        if path == "/api/config":
            try:
                payload = self._read_json()
                if not isinstance(payload, dict):
                    self._json_response(400, {"error": "invalid_config"})
                    return
                config_path = self._config_path()
                write_config(config_path, payload)
                type(self).bridge = build_handler(str(config_path), dry_run=getattr(self.bridge, "dry_run", False))
                self._json_response(200, {"ok": True})
            except json.JSONDecodeError:
                self._json_response(400, {"error": "invalid_json"})
            except RequestBodyTooLarge:
                self._json_response(413, {"error": "request_body_too_large"})
            except ValueError as e:
                self._json_response(400, {"error": "invalid_config", "message": str(e)})
            except Exception as e:
                self._json_response(500, {"error": str(e)})
            return

        if path.startswith("/api/jobs/"):
            job_name = unquote(path.split("/")[-1])
            if job_name in VALID_JOBS:
                try:
                    payload = self._read_json()
                except RequestBodyTooLarge:
                    self._json_response(413, {"error": "request_body_too_large"})
                    return
                except Exception:
                    payload = {}
                if not isinstance(payload, dict):
                    payload = {}
                dry_run = payload.get("dryRun", False)
                try:
                    cmd = [sys.executable, "-m", "delivery_ops_bridge.cli", "--config", str(self._config_path())]
                    if dry_run:
                        cmd.append("--dry-run")
                    cmd.extend(["job", job_name])
                    process = subprocess.run(
                        cmd,
                        cwd=str(self.bridge.config.root_path),
                        capture_output=True,
                        text=True,
                    )
                    self.bridge.store.append_audit_log("job_completed", {"job_name": job_name, "dry_run": dry_run, "returncode": process.returncode})
                    
                    if process.returncode == 0:
                        self._json_response(200, {"ok": True, "message": f"任务 {job_name} 运行完成"})
                    else:
                        self._json_response(500, {"error": f"任务 {job_name} 执行失败", "stderr": process.stderr})
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
        except RequestBodyTooLarge:
            self._json_response(413, {"error": "request_body_too_large"})
            return
        if not isinstance(payload, dict):
            self._json_response(400, {"error": "invalid_json"})
            return

        if payload.get("type") == "url_verification":
            self._json_response(200, {"challenge": payload.get("challenge", "")})
            return

        verify_token = self.bridge.config.feishu.verify_token
        if verify_token and not hmac.compare_digest(str(payload.get("token", "")), verify_token):
            self._json_response(403, {"error": "invalid_verify_token"})
            return

        event_id = payload.get("header", {}).get("event_id") or payload.get("uuid")
        if event_id:
            import time
            now = time.time()
            if event_id in type(self)._processed_events:
                if now - type(self)._processed_events[event_id] < 3600:
                    self._json_response(200, {"ok": True, "message": "duplicate event"})
                    return
            type(self)._processed_events[event_id] = now
            if len(type(self)._processed_events) > 1000:
                keys_to_delete = [k for k, v in type(self)._processed_events.items() if now - v > 3600]
                for k in keys_to_delete:
                    del type(self)._processed_events[k]

        try:
            import threading
            threading.Thread(target=self._async_handle_event, args=(payload,)).start()
            self._json_response(200, {"ok": True, "message": "processing in background"})
        except Exception as exc:
            self.bridge.store.append_audit_log("handler_error", {"error": str(exc)})
            self._json_response(500, {"error": str(exc)})

    def _async_handle_event(self, payload: Dict[str, Any]) -> None:
        try:
            self.bridge.handle_event(payload)
        except Exception as exc:
            self.bridge.store.append_audit_log("handler_error", {"error": str(exc)})

    def _read_json(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            raise json.JSONDecodeError("invalid content length", "", 0)
        if length > MAX_JSON_BODY_BYTES:
            raise RequestBodyTooLarge("request_body_too_large")
        body = self.rfile.read(length)
        return json.loads(body.decode("utf-8"))

    def _config_path(self) -> Path:
        return getattr(self.bridge, "config_path", resolve_config_path())

    def _dashboard_path(self, path: str) -> Path | None:
        filename = unquote(path.removeprefix("/api/dashboards/"))
        if "/" in filename or "\\" in filename or not filename.endswith(".html"):
            return None
        dashboards_dir = (self.bridge.config.data_path / "dashboards").resolve()
        filepath = (dashboards_dir / filename).resolve()
        if filepath.parent != dashboards_dir:
            return None
        return filepath

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
