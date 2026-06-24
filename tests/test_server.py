from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from delivery_ops_bridge.server import DeliveryOpsRequestHandler, build_handler


class RunningServer:
    def __init__(self, config_path: Path):
        DeliveryOpsRequestHandler.bridge = build_handler(str(config_path), dry_run=True)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), DeliveryOpsRequestHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def post_json(url: str, payload) -> tuple[int, dict]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def test_dashboard_endpoint_rejects_path_traversal(config_path: Path):
    handler = build_handler(str(config_path), dry_run=True)
    dashboard_dir = handler.config.data_path / "dashboards"
    dashboard_dir.mkdir(parents=True, exist_ok=True)
    (dashboard_dir / "safe.html").write_text("<html>ok</html>", encoding="utf-8")

    with RunningServer(config_path) as server:
        assert get_json(f"{server.base_url}/api/dashboards") == {"dashboards": ["safe.html"]}

        try:
            urllib.request.urlopen(f"{server.base_url}/api/dashboards/%2e%2e%2fconfig.json", timeout=5)
        except urllib.error.HTTPError as error:
            assert error.code == 404
        else:
            raise AssertionError("path traversal request unexpectedly succeeded")


def test_invalid_config_payload_does_not_overwrite_file(config_path: Path):
    original = config_path.read_text(encoding="utf-8")

    with RunningServer(config_path) as server:
        status, payload = post_json(f"{server.base_url}/api/config", [])

    assert status == 400
    assert payload["error"] == "invalid_config"
    assert config_path.read_text(encoding="utf-8") == original


def test_config_save_reloads_runtime_paths(config_path: Path):
    payload = json.loads(config_path.read_text(encoding="utf-8"))
    payload["runtime"]["data_dir"] = "new-data"

    with RunningServer(config_path) as server:
        status, result = post_json(f"{server.base_url}/api/config", payload)
        assert status == 200
        assert result == {"ok": True}

        dashboard_dir = config_path.parent / "new-data" / "dashboards"
        dashboard_dir.mkdir(parents=True, exist_ok=True)
        (dashboard_dir / "reloaded.html").write_text("<html>ok</html>", encoding="utf-8")

        assert get_json(f"{server.base_url}/api/dashboards") == {"dashboards": ["reloaded.html"]}


def test_logs_endpoint_filters_all_ai_events(config_path: Path):
    handler = build_handler(str(config_path), dry_run=True)
    handler.store.append_audit_log("ai_intent_failed", {"reason": "boom"})
    handler.store.append_audit_log("standup_saved", {"standup_id": "standup-1"})

    with RunningServer(config_path) as server:
        payload = get_json(f"{server.base_url}/api/logs?eventType=ai_*")

    assert payload["total"] == 1
    assert payload["logs"][0]["event_type"] == "ai_intent_failed"
