from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List

from .models import Member


@dataclass
class ProjectConfig:
    name: str = "ZenithStrat"
    root: str = "."


@dataclass
class FeishuConfig:
    app_id: str
    app_secret: str
    bot_open_id: str
    bot_name: str
    group_chat_id: str
    group_name: str
    lark_cli_path: str = "lark-cli"
    verify_token: str = ""


@dataclass
class TapdConfig:
    workspace_id: int
    api_token: str
    api_base: str
    workitem_type_id: str


@dataclass
class AIConfig:
    provider: str = "openai"
    api_base: str = "https://api.openai.com/v1"
    api_key: str = ""
    model: str = "gpt-4o"
    max_tokens: int = 4096
    temperature: float = 0.2


@dataclass
class RuntimeConfig:
    data_dir: str = "data"
    public_base_url: str = ""
    public_missing_standups: bool = False
    public_overdue_owners: bool = False


@dataclass
class AppConfig:
    project: ProjectConfig
    feishu: FeishuConfig
    tapd: TapdConfig
    ai: AIConfig
    runtime: RuntimeConfig
    members: List[Member] = field(default_factory=list)
    schedule: Dict[str, Any] = field(default_factory=dict)

    @property
    def root_path(self) -> Path:
        return Path(self.project.root).expanduser().resolve()

    @property
    def data_path(self) -> Path:
        path = Path(self.runtime.data_dir)
        if not path.is_absolute():
            path = self.root_path / path
        return path

    def member_by_open_id(self, open_id: str) -> Member | None:
        for member in self.members:
            if member.open_id == open_id:
                return member
        return None


def _env_override(value: str, env_name: str) -> str:
    return os.environ.get(env_name, value)


def load_config(path: str | None = None) -> AppConfig:
    config_path = path or os.environ.get("DELIVERY_OPS_CONFIG", "config/config.example.json")
    raw_path = Path(config_path).expanduser()
    if not raw_path.is_absolute():
        raw_path = Path.cwd() / raw_path
    with raw_path.open("r", encoding="utf-8") as fp:
        raw: Dict[str, Any] = json.load(fp)

    project = ProjectConfig(**raw.get("project", {}))
    if project.root == ".":
        project.root = str(raw_path.parent.parent if raw_path.parent.name == "config" else Path.cwd())

    feishu_raw = raw.get("feishu", {})
    feishu = FeishuConfig(
        app_id=feishu_raw.get("app_id", ""),
        app_secret=_env_override(feishu_raw.get("app_secret", ""), "FEISHU_APP_SECRET"),
        bot_open_id=feishu_raw.get("bot_open_id", ""),
        bot_name=feishu_raw.get("bot_name", "AI交付助理"),
        group_chat_id=feishu_raw.get("group_chat_id", ""),
        group_name=feishu_raw.get("group_name", "研发群"),
        lark_cli_path=feishu_raw.get("lark_cli_path", "lark-cli"),
        verify_token=feishu_raw.get("verify_token", ""),
    )

    tapd_raw = raw.get("tapd", {})
    tapd = TapdConfig(
        workspace_id=int(tapd_raw.get("workspace_id", 52052188)),
        api_token=_env_override(tapd_raw.get("api_token", ""), "TAPD_API_TOKEN"),
        api_base=tapd_raw.get("api_base", "https://api.tapd.cn"),
        workitem_type_id=tapd_raw.get("workitem_type_id", "1152052188001000017"),
    )

    ai_raw = raw.get("ai", {})
    ai = AIConfig(
        provider=ai_raw.get("provider", "openai"),
        api_base=_env_override(ai_raw.get("api_base", "https://api.openai.com/v1"), "AI_API_BASE"),
        api_key=_env_override(ai_raw.get("api_key", ""), "AI_API_KEY"),
        model=_env_override(ai_raw.get("model", "gpt-4o"), "AI_MODEL"),
        max_tokens=int(os.environ.get("AI_MAX_TOKENS", ai_raw.get("max_tokens", 4096))),
        temperature=float(os.environ.get("AI_TEMPERATURE", ai_raw.get("temperature", 0.2))),
    )

    runtime = RuntimeConfig(**raw.get("runtime", {}))
    members = [Member(**member) for member in raw.get("members", [])]
    return AppConfig(
        project=project,
        feishu=feishu,
        tapd=tapd,
        ai=ai,
        runtime=runtime,
        members=members,
        schedule=raw.get("schedule", {}),
    )
