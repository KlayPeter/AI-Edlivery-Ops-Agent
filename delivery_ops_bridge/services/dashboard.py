from __future__ import annotations

import html
import json
from collections import Counter
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List

from ..models import DashboardArtifact, utc_now_iso
from ..storage import JsonStore


class DashboardService:
    def __init__(self, store: JsonStore, data_dir: Path, project_name: str, group_name: str, public_base_url: str = ""):
        self.store = store
        self.data_dir = data_dir
        self.project_name = project_name
        self.group_name = group_name
        self.public_base_url = public_base_url.rstrip("/")

    def generate(self, day: date | None = None, highlights: List[str] | None = None) -> DashboardArtifact:
        day = day or date.today()
        date_text = day.isoformat()
        tasks = self.store.list_tasks()
        standups = self.store.list_standups(date_text)
        updates = self.store.list_task_updates()
        stats = self._build_stats(tasks, standups, date_text)
        highlights = highlights or self._default_highlights(tasks, standups)
        dashboard_data = {
            "date": date_text,
            "project_name": self.project_name,
            "group_name": self.group_name,
            "stats": stats,
            "highlights": highlights,
            "tasks": tasks,
            "standups": standups,
            "updates": updates,
        }
        stats_path = self.data_dir / "dashboards" / f"stats-{date_text}.json"
        stats_path.write_text(json.dumps(dashboard_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        html_path = self.data_dir / "dashboards" / f"delivery-dashboard-{date_text}.html"
        html_path.write_text(self._render_html(dashboard_data), encoding="utf-8")
        public_url = f"{self.public_base_url}/{html_path.name}" if self.public_base_url else None
        artifact = DashboardArtifact(
            id=f"dashboard-{date_text}",
            date=date_text,
            html_path=str(html_path),
            stats_path=str(stats_path),
            created_at=utc_now_iso(),
            public_url=public_url,
        )
        self.store.save_dashboard_artifact(artifact)
        return artifact

    def _build_stats(self, tasks: List[Dict[str, Any]], standups: List[Dict[str, Any]], date_text: str) -> Dict[str, Any]:
        statuses = Counter(task.get("status", "unknown") for task in tasks)
        total_members = max(len({task.get("primary_owner_open_id") for task in tasks if task.get("primary_owner_open_id")}), len(standups), 1)
        return {
            "total_tasks": len(tasks),
            "new_tasks_today": sum(1 for task in tasks if task.get("created_at", "").startswith(date_text)),
            "completed_today": sum(1 for task in tasks if task.get("status") == "accepted" and task.get("updated_at", "").startswith(date_text)),
            "in_progress": statuses.get("in_progress", 0) + statuses.get("confirmed", 0),
            "blocked": statuses.get("blocked", 0),
            "overdue": statuses.get("overdue", 0),
            "pending_confirmation": statuses.get("pending_confirmation", 0),
            "owner_marked_done": statuses.get("owner_marked_done", 0),
            "standup_submit_rate": round(len(standups) / total_members, 2),
        }

    def _default_highlights(self, tasks: List[Dict[str, Any]], standups: List[Dict[str, Any]]) -> List[str]:
        highlights: List[str] = []
        blocked = [task for task in tasks if task.get("status") == "blocked"]
        overdue = [task for task in tasks if task.get("status") == "overdue"]
        pending = [task for task in tasks if task.get("status") == "pending_confirmation"]
        if pending:
            highlights.append(f"{len(pending)} 个任务等待负责人确认。")
        if blocked:
            highlights.append(f"{len(blocked)} 个任务处于阻塞状态，需要协助推进。")
        if overdue:
            highlights.append(f"{len(overdue)} 个任务已超期，建议今天确认下一步。")
        if standups:
            blockers = sum(len(item.get("blockers", [])) for item in standups)
            if blockers:
                highlights.append(f"今日站会暴露 {blockers} 条阻塞/协助需求。")
        return highlights[:5] or ["今日暂无明显交付风险，建议保持任务状态更新。"]

    def _render_html(self, data: Dict[str, Any]) -> str:
        stats = data["stats"]
        tasks = data["tasks"]
        standups = data["standups"]
        highlights = data["highlights"]
        task_rows = "\n".join(self._task_row(task) for task in tasks) or "<tr><td colspan='7'>暂无任务</td></tr>"
        highlight_items = "\n".join(f"<li>{html.escape(item)}</li>" for item in highlights)
        standup_items = "\n".join(
            f"<li><strong>{html.escape(item.get('user_name', ''))}</strong>：{html.escape('；'.join(item.get('today_plan', [])) or '未填写今日计划')}</li>"
            for item in standups
        ) or "<li>暂无站会提交</li>"
        return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Delivery Dashboard {html.escape(data['date'])}</title>
  <style>
    body {{ margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #101418; color: #ecf2f8; }}
    header {{ padding: 28px 36px; background: #17202a; border-bottom: 1px solid #293647; }}
    h1 {{ margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }}
    main {{ padding: 28px 36px; }}
    .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 20px 0 28px; }}
    .metric {{ background: #18222e; border: 1px solid #2c3a4c; border-radius: 8px; padding: 16px; }}
    .metric span {{ display: block; color: #9fb0c3; font-size: 13px; }}
    .metric strong {{ display: block; margin-top: 8px; font-size: 28px; }}
    section {{ margin: 30px 0; }}
    h2 {{ font-size: 18px; margin: 0 0 14px; }}
    table {{ width: 100%; border-collapse: collapse; background: #151d27; border: 1px solid #2c3a4c; }}
    th, td {{ padding: 12px; text-align: left; border-bottom: 1px solid #253244; font-size: 14px; vertical-align: top; }}
    th {{ color: #9fb0c3; background: #1b2633; }}
    .pill {{ display: inline-block; padding: 3px 8px; border-radius: 999px; background: #253244; color: #dbe8f4; font-size: 12px; }}
    ul {{ padding-left: 22px; }}
    li {{ margin: 8px 0; }}
  </style>
</head>
<body>
  <header>
    <h1>{html.escape(data['project_name'])} Delivery Dashboard</h1>
    <div>{html.escape(data['group_name'])} · {html.escape(data['date'])}</div>
  </header>
  <main>
    <div class="grid">
      <div class="metric"><span>总任务数</span><strong>{stats['total_tasks']}</strong></div>
      <div class="metric"><span>今日新增</span><strong>{stats['new_tasks_today']}</strong></div>
      <div class="metric"><span>今日完成</span><strong>{stats['completed_today']}</strong></div>
      <div class="metric"><span>进行中</span><strong>{stats['in_progress']}</strong></div>
      <div class="metric"><span>阻塞</span><strong>{stats['blocked']}</strong></div>
      <div class="metric"><span>超期</span><strong>{stats['overdue']}</strong></div>
      <div class="metric"><span>站会提交率</span><strong>{int(stats['standup_submit_rate'] * 100)}%</strong></div>
    </div>
    <section>
      <h2>今日重点</h2>
      <ul>{highlight_items}</ul>
    </section>
    <section>
      <h2>任务列表</h2>
      <table>
        <thead><tr><th>任务</th><th>负责人</th><th>参与人</th><th>状态</th><th>优先级</th><th>截止</th><th>TAPD</th></tr></thead>
        <tbody>{task_rows}</tbody>
      </table>
    </section>
    <section>
      <h2>今日站会摘要</h2>
      <ul>{standup_items}</ul>
    </section>
  </main>
</body>
</html>
"""

    def _task_row(self, task: Dict[str, Any]) -> str:
        link = task.get("tapd_url") or ""
        link_html = f"<a href='{html.escape(link)}'>查看</a>" if link else ""
        return (
            "<tr>"
            f"<td>{html.escape(task.get('title', ''))}</td>"
            f"<td>{html.escape(task.get('primary_owner_name', ''))}</td>"
            f"<td>{html.escape('、'.join(task.get('assignee_names', [])))}</td>"
            f"<td><span class='pill'>{html.escape(task.get('status', ''))}</span></td>"
            f"<td>{html.escape(task.get('priority', ''))}</td>"
            f"<td>{html.escape(task.get('due_date') or '')}</td>"
            f"<td>{link_html}</td>"
            "</tr>"
        )
