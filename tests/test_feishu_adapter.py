from __future__ import annotations

import subprocess

from delivery_ops_bridge.adapters.feishu import FeishuAdapter
from delivery_ops_bridge.config import load_config


def test_result_parser_extracts_chat_id_and_drive_url(config_path):
    config = load_config(str(config_path))
    adapter = FeishuAdapter(config.feishu, dry_run=True)
    proc = subprocess.CompletedProcess(
        args=[],
        returncode=0,
        stdout='{"data":{"chat_id":"oc_group","file_token":"filecn123","url":"https://example.feishu.cn/file/filecn123"}}',
        stderr="",
    )

    result = adapter._result_from_process(proc)

    assert result.ok is True
    assert result.chat_id == "oc_group"
    assert result.file_token == "filecn123"
    assert result.url == "https://example.feishu.cn/file/filecn123"


def test_result_parser_handles_progress_prefix(config_path):
    config = load_config(str(config_path))
    adapter = FeishuAdapter(config.feishu, dry_run=True)
    proc = subprocess.CompletedProcess(
        args=[],
        returncode=3,
        stdout='Uploading: board.html (2.8 KB) -> Drive root folder\n{"error":{"missing_scopes":["drive:file:upload"]}}',
        stderr="",
    )

    result = adapter._result_from_process(proc)

    assert result.ok is False
    assert result.raw["error"]["missing_scopes"] == ["drive:file:upload"]


def test_permission_warning_lists_missing_scopes(config_path):
    config = load_config(str(config_path))
    adapter = FeishuAdapter(config.feishu, dry_run=True)
    failing = subprocess.CompletedProcess(
        args=[],
        returncode=3,
        stdout='{"error":{"missing_scopes":["drive:file","drive:file:upload"]}}',
        stderr="permission denied",
    )

    result = adapter._result_from_process(failing)
    warning = adapter._permission_warning(result)

    assert "drive:file" in warning
    assert "drive:file:upload" in warning
