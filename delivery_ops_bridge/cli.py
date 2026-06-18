from __future__ import annotations

import argparse
import json
import sys
from datetime import date

from .adapters.feishu import FeishuAdapter
from .adapters.tapd import TapdAdapter
from .config import load_config
from .server import build_handler, run_server
from .services.dashboard import DashboardService
from .services.jobs import ScheduledJobs
from .storage import JsonStore


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
    job_parser.add_argument("name", choices=["standup-push", "standup-remind", "standup-summary", "daily-summary", "dashboard", "overdue-scan"])
    job_parser.add_argument("--date", default=None, help="YYYY-MM-DD")

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
        result = _run_job(args.config, args.dry_run, args.name, args.date)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    return 1


def _run_job(config_path: str | None, dry_run: bool, name: str, day_text: str | None):
    config = load_config(config_path)
    store = JsonStore(config.data_path)
    feishu = FeishuAdapter(config.feishu, dry_run=dry_run)
    dashboard = DashboardService(store, config.data_path, config.project.name, config.feishu.group_name, config.runtime.public_base_url)
    jobs = ScheduledJobs(config, store, feishu, dashboard)
    day = date.fromisoformat(day_text) if day_text else None
    methods = {
        "standup-push": jobs.standup_push,
        "standup-remind": jobs.standup_remind,
        "standup-summary": jobs.standup_summary,
        "daily-summary": jobs.daily_summary,
        "dashboard": jobs.dashboard_generate,
        "overdue-scan": jobs.overdue_scan,
    }
    return methods[name](day)


if __name__ == "__main__":
    raise SystemExit(main())
