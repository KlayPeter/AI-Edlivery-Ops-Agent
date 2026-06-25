from __future__ import annotations

import threading
import time
from datetime import date, datetime
from typing import Callable, Dict

from ..models import utc_now_iso
from .dashboard import DashboardService
from .jobs import ScheduledJobs
from .message_handler import MessageHandler


JOB_TO_CONFIG_KEY = {
    "standup-push": "standup_push",
    "standup-second-remind": "standup_second_remind",
    "standup-mark-missing": "standup_mark_missing",
    "standup-summary": "standup_summary",
    "overdue-scan": "overdue_scan",
    "daily-summary": "daily_summary",
    "dashboard": "dashboard",
}


class InProcessScheduler:
    def __init__(
        self,
        get_handler: Callable[[], MessageHandler],
        interval_seconds: float = 30.0,
    ):
        self.get_handler = get_handler
        self.interval_seconds = interval_seconds
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="delivery-ops-scheduler", daemon=True)

    def start(self) -> None:
        if not self._thread.is_alive():
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick(datetime.now())
            except Exception:
                try:
                    self.get_handler().store.append_audit_log("scheduler_error", {"at": utc_now_iso()})
                except Exception:
                    pass
            self._stop.wait(self.interval_seconds)

    def tick(self, now: datetime) -> Dict[str, str]:
        handler = self.get_handler()
        results: Dict[str, str] = {}
        for group in handler.config.groups:
            group_id = group.chat_id
            if not group_id:
                continue
            for job_name, config_key in JOB_TO_CONFIG_KEY.items():
                scheduled_time = group.schedule.get(config_key)
                if not self._is_due(scheduled_time, now):
                    continue
                if not group.schedule.get(f"{config_key}_enabled", True):
                    continue
                key = f"scheduled:{job_name}:{group_id}:{now.date().isoformat()}:{scheduled_time}"
                if handler.store.has_idempotency_key(key):
                    continue
                handler.store.set_idempotency_key(key, {"started_at": utc_now_iso(), "job_name": job_name, "group_id": group_id})
                try:
                    payload = self._run_job(handler, job_name, group_id, now.date())
                    handler.store.set_idempotency_key(
                        key,
                        {"completed_at": utc_now_iso(), "job_name": job_name, "group_id": group_id, "result": payload},
                    )
                    handler.store.append_audit_log(
                        "job_completed",
                        {"job_name": job_name, "group_id": group_id, "trigger": "scheduler", "result": payload},
                    )
                    results[f"{job_name}:{group_id}"] = "completed"
                except Exception as exc:
                    handler.store.set_idempotency_key(
                        key,
                        {"failed_at": utc_now_iso(), "job_name": job_name, "group_id": group_id, "error": str(exc)},
                    )
                    handler.store.append_audit_log(
                        "job_failed",
                        {"job_name": job_name, "group_id": group_id, "trigger": "scheduler", "error": str(exc)},
                    )
                    results[f"{job_name}:{group_id}"] = "failed"
        return results

    def _run_job(self, handler: MessageHandler, job_name: str, group_id: str, day: date):
        llm = handler.intent_parser.llm if handler.intent_parser else None
        dashboard = DashboardService(
            handler.store,
            handler.config.data_path,
            handler.config.project.name,
            handler.config.runtime.public_base_url,
        )
        jobs = ScheduledJobs(handler.config, handler.store, handler.feishu, dashboard, llm)
        methods = {
            "standup-push": jobs.standup_push,
            "standup-second-remind": jobs.standup_second_remind,
            "standup-mark-missing": jobs.standup_mark_missing,
            "standup-summary": jobs.standup_summary,
            "overdue-scan": jobs.overdue_scan,
            "daily-summary": jobs.daily_summary,
            "dashboard": jobs.dashboard_generate,
        }
        return methods[job_name](group_id, day)

    def _is_due(self, scheduled_time, now: datetime) -> bool:
        if not isinstance(scheduled_time, str):
            return False
        try:
            hour_text, minute_text = scheduled_time.split(":", 1)
            return int(hour_text) == now.hour and int(minute_text) == now.minute
        except (TypeError, ValueError):
            return False
