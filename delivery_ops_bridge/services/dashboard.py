from __future__ import annotations

import html
import json
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List

from ..models import DashboardArtifact, utc_now_iso
from ..storage import JsonStore

STATUS_LABELS = {
    "pending_primary_owner": "待指定主负责人",
    "pending_confirmation": "待负责人确认",
    "confirmed": "已确认",
    "in_progress": "进行中",
    "blocked": "阻塞",
    "owner_marked_done": "待验收",
    "accepted": "已验收",
    "cancelled": "已取消",
    "overdue": "已超期",
}
STATUS_SORT = {"blocked": 0, "overdue": 1, "pending_primary_owner": 2, "pending_confirmation": 3, "owner_marked_done": 4}
PRIORITY_SORT = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}


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
        all_tasks = self.store.list_tasks()
        active_tasks = [t for t in all_tasks if t.get("status") != "cancelled" and not t.get("is_draft")]
        tasks = self._sort_tasks(active_tasks)
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
            "status_distribution": self._status_distribution(tasks),
            "blockers": self._build_blockers(tasks, standups),
            "risks": self._build_risks(tasks, standups),
            "standup_summary": self._build_standup_summary(standups),
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
        blockers = data["blockers"]
        risks = data["risks"]
        standup_summary = data["standup_summary"]
        task_rows = "\n".join(self._task_row(task) for task in tasks) or "<tr><td colspan='7'>暂无任务</td></tr>"
        highlight_items = "\n".join(f"<li>{html.escape(item)}</li>" for item in highlights)
        status_rows = "\n".join(
            f"<tr><td><span class='pill pill-{html.escape(item['status'])}'>{html.escape(item['label'])}</span></td><td>{item['count']}</td></tr>"
            for item in data["status_distribution"]
        ) or "<tr><td colspan='2'>暂无任务</td></tr>"
        blocker_rows = "\n".join(self._issue_row(item) for item in blockers) or "<tr><td colspan='4'>暂无阻塞事项</td></tr>"
        risk_rows = "\n".join(self._issue_row(item) for item in risks) or "<tr><td colspan='4'>暂无风险提示</td></tr>"
        standup_items = "\n".join(
            f"<li><strong>{html.escape(item.get('user_name', ''))}</strong>：{html.escape('；'.join(item.get('today_plan', [])) or '未填写今日计划')}</li>"
            for item in standups
        ) or "<li>暂无站会提交</li>"
        standup_blockers = "\n".join(f"<li>{html.escape(item)}</li>" for item in standup_summary["blockers"]) or "<li>暂无站会阻塞</li>"
        standup_decisions = "\n".join(f"<li>{html.escape(item)}</li>" for item in standup_summary["decisions_needed"]) or "<li>暂无待决策事项</li>"
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
    .two-col {{ display: grid; grid-template-columns: minmax(220px, 0.7fr) minmax(280px, 1.3fr); gap: 18px; align-items: start; }}
    table {{ width: 100%; border-collapse: collapse; background: #151d27; border: 1px solid #2c3a4c; }}
    th, td {{ padding: 12px; text-align: left; border-bottom: 1px solid #253244; font-size: 14px; vertical-align: top; }}
    th {{ color: #9fb0c3; background: #1b2633; }}
    .pill {{ display: inline-block; padding: 4px 10px; border-radius: 999px; background: #253244; color: #dbe8f4; font-size: 12px; font-weight: 500; line-height: 1; }}
    .pill-accepted {{ background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }}
    .pill-in_progress, .pill-confirmed {{ background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); }}
    .pill-pending_confirmation, .pill-pending_primary_owner {{ background: rgba(156, 163, 175, 0.15); color: #9ca3af; border: 1px solid rgba(156, 163, 175, 0.3); }}
    .pill-blocked {{ background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }}
    .pill-overdue {{ background: rgba(249, 115, 22, 0.15); color: #fb923c; border: 1px solid rgba(249, 115, 22, 0.3); }}
    .pill-owner_marked_done {{ background: rgba(139, 92, 246, 0.15); color: #a78bfa; border: 1px solid rgba(139, 92, 246, 0.3); }}
    .pill-cancelled {{ background: rgba(107, 114, 128, 0.15); color: #9ca3af; border: 1px solid rgba(107, 114, 128, 0.3); }}
    ul {{ padding-left: 22px; }}
    li {{ margin: 8px 0; }}
    .sortable {{ cursor: pointer; user-select: none; transition: background 0.2s; }}
    .sortable:hover {{ background: #253244; }}
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
    <section class="two-col">
      <div>
        <h2>状态统计</h2>
        <table>
          <thead><tr><th>状态</th><th>数量</th></tr></thead>
          <tbody>{status_rows}</tbody>
        </table>
      </div>
      <div>
        <h2>阻塞事项</h2>
        <table>
          <thead><tr><th>描述</th><th>相关人</th><th>影响</th><th>建议动作</th></tr></thead>
          <tbody>{blocker_rows}</tbody>
        </table>
      </div>
    </section>
    <section>
      <h2>任务列表</h2>
      <table id="task-table">
        <thead><tr><th>任务</th><th>负责人</th><th>参与人</th><th>状态</th><th class="sortable" onclick="sortTable(4)">优先级 ↕</th><th class="sortable" onclick="sortTable(5)">截止 ↕</th><th>TAPD</th></tr></thead>
        <tbody id="task-tbody">{task_rows}</tbody>
      </table>
      <div id="pagination" style="margin-top: 12px; display: flex; gap: 8px;"></div>
    </section>
    <section>
      <h2>风险提示</h2>
      <table>
        <thead><tr><th>描述</th><th>相关人</th><th>影响</th><th>建议动作</th></tr></thead>
        <tbody>{risk_rows}</tbody>
      </table>
    </section>
    <section>
      <h2>今日站会摘要</h2>
      <div class="grid">
        <div class="metric"><span>已提交人数</span><strong>{standup_summary['submitted']}</strong></div>
        <div class="metric"><span>站会阻塞</span><strong>{len(standup_summary['blockers'])}</strong></div>
        <div class="metric"><span>待决策事项</span><strong>{len(standup_summary['decisions_needed'])}</strong></div>
      </div>
      <ul>{standup_items}</ul>
      <h2>团队阻塞</h2>
      <ul>{standup_blockers}</ul>
      <h2>需要决策</h2>
      <ul>{standup_decisions}</ul>
    </section>
  </main>
  <script>
    let currentPage = 1;
    const pageSize = 10;
    let currentSortCol = -1;
    let currentSortAsc = 1;

    function renderTable() {{
      const tbody = document.getElementById('task-tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      if (rows.length === 0 || rows[0].cells.length < 5) return;
      
      const totalPages = Math.ceil(rows.length / pageSize);
      
      rows.forEach((row, index) => {{
        if (index >= (currentPage - 1) * pageSize && index < currentPage * pageSize) {{
          row.style.display = '';
        }} else {{
          row.style.display = 'none';
        }}
      }});

      const pagination = document.getElementById('pagination');
      pagination.innerHTML = '';
      if (totalPages > 1) {{
        for (let i = 1; i <= totalPages; i++) {{
          const btn = document.createElement('button');
          btn.innerText = i;
          btn.style.padding = '4px 10px';
          btn.style.background = i === currentPage ? '#3b82f6' : '#253244';
          btn.style.color = '#fff';
          btn.style.border = 'none';
          btn.style.borderRadius = '4px';
          btn.style.cursor = 'pointer';
          btn.onclick = () => {{
            currentPage = i;
            renderTable();
          }};
          pagination.appendChild(btn);
        }}
      }}
    }}

    function sortTable(colIndex) {{
      const tbody = document.getElementById('task-tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      if (rows.length === 0 || rows[0].cells.length < 5) return;
      
      if (currentSortCol === colIndex) {{
        currentSortAsc *= -1;
      }} else {{
        currentSortCol = colIndex;
        currentSortAsc = 1;
      }}

      rows.sort((a, b) => {{
        let valA = a.cells[colIndex].innerText.trim();
        let valB = b.cells[colIndex].innerText.trim();
        if (valA === '') valA = 'ZZZZ';
        if (valB === '') valB = 'ZZZZ';
        return valA.localeCompare(valB) * currentSortAsc;
      }});

      rows.forEach(row => tbody.appendChild(row));
      currentPage = 1;
      renderTable();
    }}

    document.addEventListener('DOMContentLoaded', () => {{
      renderTable();
    }});
  </script>
</body>
</html>
"""

    def _task_row(self, task: Dict[str, Any]) -> str:
        link = task.get("tapd_url") or ""
        link_html = f"<a href='{html.escape(link)}'>查看</a>" if link else ""
        status_raw = task.get("status", "")
        status_label = STATUS_LABELS.get(status_raw, status_raw)
        return (
            "<tr>"
            f"<td>{html.escape(task.get('title', ''))}</td>"
            f"<td>{html.escape(task.get('primary_owner_name', ''))}</td>"
            f"<td>{html.escape('、'.join(task.get('assignee_names', [])))}</td>"
            f"<td><span class='pill pill-{html.escape(status_raw)}'>{html.escape(status_label)}</span></td>"
            f"<td>{html.escape(task.get('priority', ''))}</td>"
            f"<td>{html.escape(task.get('due_date') or '')}</td>"
            f"<td>{link_html}</td>"
            "</tr>"
        )

    def _issue_row(self, item: Dict[str, Any]) -> str:
        return (
            "<tr>"
            f"<td>{html.escape(item.get('title', ''))}</td>"
            f"<td>{html.escape(item.get('owner', ''))}</td>"
            f"<td>{html.escape(item.get('impact', ''))}</td>"
            f"<td>{html.escape(item.get('action', ''))}</td>"
            "</tr>"
        )

    def _sort_tasks(self, tasks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        def key(task: Dict[str, Any]):
            status_rank = STATUS_SORT.get(task.get("status", ""), 9)
            priority_rank = PRIORITY_SORT.get(task.get("priority", "P2"), 5)
            due = task.get("due_date") or "9999-12-31"
            updated = task.get("updated_at", "")
            return (status_rank, priority_rank, due, updated)

        return sorted(tasks, key=key)

    def _status_distribution(self, tasks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        counts = Counter(task.get("status", "unknown") for task in tasks)
        return [
            {"status": status, "label": STATUS_LABELS.get(status, status), "count": count}
            for status, count in sorted(counts.items(), key=lambda item: STATUS_SORT.get(item[0], 9))
        ]

    def _build_blockers(self, tasks: List[Dict[str, Any]], standups: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        values = []
        for task in tasks:
            if task.get("status") != "blocked" or not self._blocked_long_enough(task):
                continue
            blocker = task.get("blocker_info") or {}
            values.append(
                {
                    "title": blocker.get("reason") or task.get("title", ""),
                    "owner": blocker.get("blocked_by_name") or task.get("primary_owner_name", ""),
                    "impact": "任务阻塞超过 24 小时",
                    "action": blocker.get("suggested_action") or "确认协助人和下一步恢复动作",
                }
            )
        for item in standups:
            for blocker in item.get("blockers", []):
                values.append(
                    {
                        "title": blocker,
                        "owner": item.get("user_name", ""),
                        "impact": "站会暴露协助需求",
                        "action": "当天确认协助对象和处理时限",
                    }
                )
        return values

    def _build_risks(self, tasks: List[Dict[str, Any]], standups: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        values = [
            {
                "title": task.get("title", ""),
                "owner": task.get("primary_owner_name", ""),
                "impact": f"任务状态：{STATUS_LABELS.get(task.get('status', ''), task.get('status', ''))}",
                "action": "确认是否需要调整计划或资源",
            }
            for task in tasks
            if task.get("status") == "overdue" or (task.get("status") == "blocked" and self._blocked_long_enough(task))
        ]
        for item in standups:
            for risk in item.get("risks", []):
                values.append(
                    {
                        "title": risk,
                        "owner": item.get("user_name", ""),
                        "impact": "站会提出延期或交付风险",
                        "action": "确认风险等级和缓解动作",
                    }
                )
        return values

    def _build_standup_summary(self, standups: List[Dict[str, Any]]) -> Dict[str, Any]:
        return {
            "submitted": len(standups),
            "today_plan": [plan for item in standups for plan in item.get("today_plan", [])],
            "blockers": [blocker for item in standups for blocker in item.get("blockers", [])],
            "decisions_needed": [decision for item in standups for decision in item.get("decisions_needed", [])],
        }

    def _blocked_long_enough(self, task: Dict[str, Any]) -> bool:
        blocked_at = self._parse_iso_datetime(str(task.get("blocked_at") or ""))
        if not blocked_at:
            return False
        return datetime.utcnow() - blocked_at >= timedelta(hours=24)

    def _parse_iso_datetime(self, value: str) -> datetime | None:
        if not value:
            return None
        try:
            return datetime.fromisoformat(value.replace("Z", ""))
        except ValueError:
            return None
