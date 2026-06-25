from __future__ import annotations

import argparse
import json
import sys
from datetime import date

from .adapters.feishu import FeishuAdapter
from .adapters.llm import LLMAdapter
from .adapters.tapd import TapdAdapter
from .config import load_config
from .server import build_handler, run_server
from .services.dashboard import DashboardService
from .services.jobs import ScheduledJobs
from .storage import JsonStore

JOB_CONFIG_KEYS = {
    "standup-push": "standup_push",
    "standup-remind": "standup_second_remind",
    "standup-second-remind": "standup_second_remind",
    "standup-mark-missing": "standup_mark_missing",
    "standup-summary": "standup_summary",
    "daily-summary": "daily_summary",
    "dashboard": "dashboard",
    "overdue-scan": "overdue_scan",
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="delivery-ops-bridge")
    parser.add_argument("--config", default=None, help="Path to JSON config file")
    parser.add_argument("--dry-run", action="store_true", help="Do not call lark-cli or TAPD")
    subparsers = parser.add_subparsers(dest="command", required=True)

    server_parser = subparsers.add_parser("server", help="Run Feishu webhook server")
    server_parser.add_argument("--host", default="0.0.0.0")
    server_parser.add_argument("--port", type=int, default=None)

    handle_parser = subparsers.add_parser("handle-event", help="Handle one Feishu event JSON from stdin")
    handle_parser.add_argument("--pretty", action="store_true")

    job_parser = subparsers.add_parser("job", help="Run a scheduled job")
    job_parser.add_argument("name", choices=list(JOB_CONFIG_KEYS))
    job_parser.add_argument("--date", default=None, help="YYYY-MM-DD")
    job_parser.add_argument("--group-id", default=None, help="Specific group chat ID")

    args = parser.parse_args(argv)
    if args.command == "server":
        run_server(args.config, host=args.host, port=args.port, dry_run=args.dry_run)
        return 0
    if args.command == "handle-event":
        payload = json.load(sys.stdin)
        handler = build_handler(args.config, dry_run=args.dry_run)
        result = handler.handle_event(payload)
        print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))
        return 0
    if args.command == "job":
        result = _run_job(args.config, args.dry_run, args.name, args.date, args.group_id)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    return 1


def _run_job(config_path: str | None, dry_run: bool, name: str, day_text: str | None, group_id: str | None = None):
    config = load_config(config_path)
    
    config_key = JOB_CONFIG_KEYS[name]
    # If no group_id is specified, we will run it for all groups
    if group_id:
        group = config.group_by_chat_id(group_id)
        if group and not group.schedule.get(f"{config_key}_enabled", True):
            return {"ok": True, "message": f"任务 {name} 已在群 {group.name} 禁用，跳过执行。"}
    else:
        # Check global or legacy? We just proceed and let the job iterate. Wait, jobs now require group_id.
        pass
        
    store = JsonStore(config.data_path)
    feishu = FeishuAdapter(config.feishu, dry_run=dry_run)
    feishu.set_audit_callback(store.append_audit_log)
    llm = LLMAdapter(config.ai, dry_run=dry_run)
    dashboard = DashboardService(store, config.data_path, config.project.name, config.runtime.public_base_url)
    jobs = ScheduledJobs(config, store, feishu, dashboard, llm)
    day = date.fromisoformat(day_text) if day_text else None
    methods = {
        "standup-push": jobs.standup_push,
        "standup-remind": jobs.standup_second_remind,
        "standup-second-remind": jobs.standup_second_remind,
        "standup-mark-missing": jobs.standup_mark_missing,
        "standup-summary": jobs.standup_summary,
        "daily-summary": jobs.daily_summary,
        "dashboard": jobs.dashboard_generate,
        "overdue-scan": jobs.overdue_scan,
    }
    
    if group_id:
        return methods[name](group_id, day)
    
    results = {}
    for group in config.groups:
        if not group.schedule.get(f"{config_key}_enabled", True):
            continue
        res = methods[name](group.chat_id, day)
        results[group.chat_id] = res
    return results


if __name__ == "__main__":
    raise SystemExit(main())
