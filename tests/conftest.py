from __future__ import annotations

import json
from pathlib import Path

import pytest

from delivery_ops_bridge.adapters.feishu import FeishuAdapter
from delivery_ops_bridge.adapters.tapd import TapdAdapter
from delivery_ops_bridge.config import load_config
from delivery_ops_bridge.services.dashboard import DashboardService
from delivery_ops_bridge.services.message_handler import MessageHandler
from delivery_ops_bridge.storage import JsonStore


@pytest.fixture()
def config_path(tmp_path: Path) -> Path:
    config = {
        "project": {"name": "TestProject", "root": str(tmp_path)},
        "feishu": {
            "app_id": "cli_test",
            "app_secret": "",
            "bot_open_id": "ou_bot",
            "bot_name": "AI交付助理",
            "group_chat_id": "oc_group",
            "group_name": "研发群",
            "lark_cli_path": "lark-cli",
            "verify_token": "",
        },
        "tapd": {
            "workspace_id": 52052188,
            "api_token": "",
            "api_base": "https://api.tapd.cn",
            "workitem_type_id": "1152052188001000017",
        },
        "ai": {"api_key": "", "api_base": "https://api.openai.com/v1", "model": "gpt-4o"},
        "runtime": {"data_dir": "data", "public_base_url": ""},
        "members": [
            {"open_id": "ou_creator", "name": "Figo", "role": "cto", "is_active": True},
            {"open_id": "ou_zhangsan", "name": "张三", "role": "backend", "is_active": True},
            {"open_id": "ou_lisi", "name": "李四", "role": "frontend", "is_active": True},
        ],
    }
    path = tmp_path / "config.json"
    path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    return path


@pytest.fixture()
def handler(config_path: Path) -> MessageHandler:
    config = load_config(str(config_path))
    store = JsonStore(config.data_path)
    feishu = FeishuAdapter(config.feishu, dry_run=True)
    tapd = TapdAdapter(config.tapd, dry_run=True)
    dashboard = DashboardService(store, config.data_path, config.project.name, config.feishu.group_name)
    return MessageHandler(config, store, feishu, tapd, dashboard)


def feishu_event(
    text: str,
    message_id: str = "om_1",
    chat_type: str = "group",
    sender: str = "ou_creator",
    chat_id: str = "oc_group",
    mentions=None,
    parent_id: str | None = None,
    root_id: str | None = None,
):
    mentions = mentions or []
    return {
        "schema": "2.0",
        "header": {"event_type": "im.message.receive_v1"},
        "event": {
            "sender": {"sender_id": {"open_id": sender}},
            "message": {
                "message_id": message_id,
                "chat_id": chat_id,
                "chat_type": chat_type,
                "message_type": "text",
                "content": json.dumps({"text": text}, ensure_ascii=False),
                "mentions": mentions,
                "create_time": "2026-06-18T10:00:00Z",
                **({"parent_id": parent_id} if parent_id else {}),
                **({"root_id": root_id} if root_id else {}),
            },
        },
    }


def mention(open_id: str, name: str):
    return {"id": {"open_id": open_id}, "name": name}
