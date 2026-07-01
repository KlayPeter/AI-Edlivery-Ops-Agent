import * as fs from 'fs';
import * as path from 'path';
import { PrismaStore } from '@/core/storage';
import { DashboardArtifact, utcNowIso } from '@/models/types';
import dayjs from 'dayjs';

const STATUS_LABELS: Record<string, string> = {
    "pending_primary_owner": "待指定主负责人",
    "pending_confirmation": "待负责人确认",
    "confirmed": "已确认",
    "in_progress": "进行中",
    "blocked": "阻塞",
    "owner_marked_done": "待验收",
    "accepted": "已验收",
    "cancelled": "已取消",
    "overdue": "已超期",
};

const STATUS_SORT: Record<string, number> = { "blocked": 0, "overdue": 1, "pending_primary_owner": 2, "pending_confirmation": 3, "owner_marked_done": 4 };
const PRIORITY_SORT: Record<string, number> = { "P0": 0, "P1": 1, "P2": 2, "P3": 3 };

function escapeHtml(unsafe: string): string {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

export class DashboardService {
    private store: PrismaStore;
    private dataDir: string;
    private projectName: string;
    private publicBaseUrl: string;

    constructor(store: PrismaStore, dataDir: string, projectName: string, publicBaseUrl: string = "") {
        this.store = store;
        this.dataDir = dataDir;
        this.projectName = projectName;
        this.publicBaseUrl = publicBaseUrl.replace(/\/$/, "");
    }

    async generateForGroup(group: any, day: Date = new Date(), highlights?: string[]): Promise<DashboardArtifact> {
        const dateText = dayjs(day).format('YYYY-MM-DD');
        const allTasks = await this.store.listTasks();
        const activeTasks = allTasks.filter((t: any) => t.status !== "cancelled" && t.status !== "deleted" && !t.is_draft && t.source_group_id === group.chat_id);
        const tasks = this.sortTasks(activeTasks);
        
        const groupOpenIds = new Set(group.members.map((m: any) => m.open_id));
        const allStandups = await this.store.listStandups(dateText);
        const standups = allStandups.filter((s: any) => groupOpenIds.has(s.open_id));
        
        const updates = await this.store.listTaskUpdates();
        const stats = this.buildStats(tasks, standups, dateText);
        const resolvedHighlights = highlights || this.defaultHighlights(tasks, standups);
        
        const dashboardData = {
            date: dateText,
            project_name: this.projectName,
            group_name: group.name,
            stats,
            highlights: resolvedHighlights,
            tasks,
            standups,
            updates,
            status_distribution: this.statusDistribution(tasks),
            blockers: this.buildBlockers(tasks, standups),
            risks: this.buildRisks(tasks, standups),
            standup_summary: this.buildStandupSummary(standups),
        };

        const dashboardsDir = path.join(this.dataDir, "dashboards");
        if (!fs.existsSync(dashboardsDir)) fs.mkdirSync(dashboardsDir, { recursive: true });

        const statsPath = path.join(dashboardsDir, `stats-${group.chat_id}-${dateText}.json`);
        fs.writeFileSync(statsPath, JSON.stringify(dashboardData, null, 2) + "\n", 'utf-8');
        
        const htmlPath = path.join(dashboardsDir, `delivery-dashboard-${group.chat_id}-${dateText}.html`);
        fs.writeFileSync(htmlPath, this.renderHtml(dashboardData), 'utf-8');
        
        const publicUrl = this.publicBaseUrl ? `${this.publicBaseUrl}/${path.basename(htmlPath)}` : undefined;
        
        const artifact: DashboardArtifact = {
            id: `dashboard-${group.chat_id}-${dateText}`,
            date: dateText,
            html_path: htmlPath,
            stats_path: statsPath,
            created_at: utcNowIso(),
            public_url: publicUrl,
        };
        await this.store.saveDashboardArtifact(artifact);
        return artifact;
    }

    private buildStats(tasks: any[], standups: any[], dateText: string): any {
        const statuses = tasks.reduce((acc, task) => {
            const st = task.status || "unknown";
            acc[st] = (acc[st] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
        
        const owners = new Set(tasks.map(t => t.primary_owner_open_id).filter(Boolean));
        const totalMembers = Math.max(owners.size, standups.length, 1);
        
        return {
            total_tasks: tasks.length,
            new_tasks_today: tasks.filter(t => (t.created_at || "").startsWith(dateText)).length,
            completed_today: tasks.filter(t => t.status === "accepted" && (t.updated_at || "").startsWith(dateText)).length,
            in_progress: (statuses["in_progress"] || 0) + (statuses["confirmed"] || 0),
            blocked: statuses["blocked"] || 0,
            overdue: statuses["overdue"] || 0,
            pending_confirmation: statuses["pending_confirmation"] || 0,
            owner_marked_done: statuses["owner_marked_done"] || 0,
            standup_submit_rate: Math.round((standups.length / totalMembers) * 100) / 100,
        };
    }

    private defaultHighlights(tasks: any[], standups: any[]): string[] {
        const highlights: string[] = [];
        const blocked = tasks.filter(t => t.status === "blocked");
        const overdue = tasks.filter(t => t.status === "overdue");
        const pending = tasks.filter(t => t.status === "pending_confirmation");
        
        if (pending.length) highlights.push(`${pending.length} 个任务等待负责人确认。`);
        if (blocked.length) highlights.push(`${blocked.length} 个任务处于阻塞状态，需要协助推进。`);
        if (overdue.length) highlights.push(`${overdue.length} 个任务已超期，建议今天确认下一步。`);
        
        if (standups.length) {
            const blockersCount = standups.reduce((sum, s) => sum + (s.blockers?.length || 0), 0);
            if (blockersCount) highlights.push(`今日站会暴露 ${blockersCount} 条阻塞/协助需求。`);
        }
        
        if (!highlights.length) highlights.push("今日暂无明显交付风险，建议保持任务状态更新。");
        return highlights.slice(0, 5);
    }

    private renderHtml(data: any): string {
        const stats = data.stats;
        const taskRows = data.tasks.map(this.taskRow).join("\n") || "<tr><td colspan='7'>暂无任务</td></tr>";
        const highlightItems = data.highlights.map((i: string) => `<li>${escapeHtml(i)}</li>`).join("\n");
        const statusRows = data.status_distribution.map((i: any) => `<tr><td><span class='pill pill-${escapeHtml(i.status)}'>${escapeHtml(i.label)}</span></td><td>${i.count}</td></tr>`).join("\n") || "<tr><td colspan='2'>暂无任务</td></tr>";
        const blockerRows = data.blockers.map((i: any) => this.issueRow(i)).join("\n") || "<tr><td colspan='4'>暂无阻塞事项</td></tr>";
        const riskRows = data.risks.map((i: any) => this.issueRow(i)).join("\n") || "<tr><td colspan='4'>暂无风险提示</td></tr>";
        const standupItems = data.standups.map((i: any) => `<li><strong>${escapeHtml(i.user_name || '')}</strong>：${escapeHtml((i.today_plan || []).join('；') || '未填写今日计划')}</li>`).join("\n") || "<li>暂无站会提交</li>";
        const standupBlockers = data.standup_summary.blockers.map((i: string) => `<li>${escapeHtml(i)}</li>`).join("\n") || "<li>暂无站会阻塞</li>";
        const standupDecisions = data.standup_summary.decisions_needed.map((i: string) => `<li>${escapeHtml(i)}</li>`).join("\n") || "<li>暂无待决策事项</li>";

        return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Delivery Dashboard ${escapeHtml(data.date)}</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #101418; color: #ecf2f8; }
    header { padding: 28px 36px; background: #17202a; border-bottom: 1px solid #293647; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
    main { padding: 28px 36px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 20px 0 28px; }
    .metric { background: #18222e; border: 1px solid #2c3a4c; border-radius: 8px; padding: 16px; }
    .metric span { display: block; color: #9fb0c3; font-size: 13px; }
    .metric strong { display: block; margin-top: 8px; font-size: 28px; }
    section { margin: 30px 0; }
    h2 { font-size: 18px; margin: 0 0 14px; }
    .two-col { display: grid; grid-template-columns: minmax(220px, 0.7fr) minmax(280px, 1.3fr); gap: 18px; align-items: start; }
    table { width: 100%; border-collapse: collapse; background: #151d27; border: 1px solid #2c3a4c; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #253244; font-size: 14px; vertical-align: top; }
    th { color: #9fb0c3; background: #1b2633; }
    .pill { display: inline-block; padding: 4px 10px; border-radius: 999px; background: #253244; color: #dbe8f4; font-size: 12px; font-weight: 500; line-height: 1; }
    .pill-accepted { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .pill-in_progress, .pill-confirmed { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); }
    .pill-pending_confirmation, .pill-pending_primary_owner { background: rgba(156, 163, 175, 0.15); color: #9ca3af; border: 1px solid rgba(156, 163, 175, 0.3); }
    .pill-blocked { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
    .pill-overdue { background: rgba(249, 115, 22, 0.15); color: #fb923c; border: 1px solid rgba(249, 115, 22, 0.3); }
    .pill-owner_marked_done { background: rgba(139, 92, 246, 0.15); color: #a78bfa; border: 1px solid rgba(139, 92, 246, 0.3); }
    .pill-cancelled { background: rgba(107, 114, 128, 0.15); color: #9ca3af; border: 1px solid rgba(107, 114, 128, 0.3); }
    ul { padding-left: 22px; }
    li { margin: 8px 0; }
    .sortable { cursor: pointer; user-select: none; transition: background 0.2s; }
    .sortable:hover { background: #253244; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(data.project_name)} Delivery Dashboard</h1>
    <div>${escapeHtml(data.group_name)} · ${escapeHtml(data.date)}</div>
  </header>
  <main>
    <div class="grid">
      <div class="metric"><span>总任务数</span><strong>${stats.total_tasks}</strong></div>
      <div class="metric"><span>今日新增</span><strong>${stats.new_tasks_today}</strong></div>
      <div class="metric"><span>今日完成</span><strong>${stats.completed_today}</strong></div>
      <div class="metric"><span>进行中</span><strong>${stats.in_progress}</strong></div>
      <div class="metric"><span>阻塞</span><strong>${stats.blocked}</strong></div>
      <div class="metric"><span>超期</span><strong>${stats.overdue}</strong></div>
      <div class="metric"><span>站会提交率</span><strong>${Math.floor(stats.standup_submit_rate * 100)}%</strong></div>
    </div>
    <section>
      <h2>今日重点</h2>
      <ul>${highlightItems}</ul>
    </section>
    <section class="two-col">
      <div>
        <h2>状态统计</h2>
        <table>
          <thead><tr><th>状态</th><th>数量</th></tr></thead>
          <tbody>${statusRows}</tbody>
        </table>
      </div>
      <div>
        <h2>阻塞事项</h2>
        <table>
          <thead><tr><th>描述</th><th>相关人</th><th>影响</th><th>建议动作</th></tr></thead>
          <tbody>${blockerRows}</tbody>
        </table>
      </div>
    </section>
    <section>
      <h2>任务列表</h2>
      <table id="task-table">
        <thead><tr><th>任务</th><th>负责人</th><th>参与人</th><th>状态</th><th class="sortable" onclick="sortTable(4)">优先级 ↕</th><th class="sortable" onclick="sortTable(5)">截止 ↕</th><th>TAPD</th></tr></thead>
        <tbody id="task-tbody">${taskRows}</tbody>
      </table>
      <div id="pagination" style="margin-top: 12px; display: flex; gap: 8px;"></div>
    </section>
    <section>
      <h2>风险提示</h2>
      <table>
        <thead><tr><th>描述</th><th>相关人</th><th>影响</th><th>建议动作</th></tr></thead>
        <tbody>${riskRows}</tbody>
      </table>
    </section>
    <section>
      <h2>今日站会摘要</h2>
      <div class="grid">
        <div class="metric"><span>已提交人数</span><strong>${data.standup_summary.submitted}</strong></div>
        <div class="metric"><span>站会阻塞</span><strong>${data.standup_summary.blockers.length}</strong></div>
        <div class="metric"><span>待决策事项</span><strong>${data.standup_summary.decisions_needed.length}</strong></div>
      </div>
      <ul>${standupItems}</ul>
      <h2>团队阻塞</h2>
      <ul>${standupBlockers}</ul>
      <h2>需要决策</h2>
      <ul>${standupDecisions}</ul>
    </section>
  </main>
  <script>
    let currentPage = 1;
    const pageSize = 10;
    let currentSortCol = -1;
    let currentSortAsc = 1;

    function renderTable() {
      const tbody = document.getElementById('task-tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      if (rows.length === 0 || rows[0].cells.length < 5) return;
      
      const totalPages = Math.ceil(rows.length / pageSize);
      
      rows.forEach((row, index) => {
        if (index >= (currentPage - 1) * pageSize && index < currentPage * pageSize) {
          row.style.display = '';
        } else {
          row.style.display = 'none';
        }
      });

      const pagination = document.getElementById('pagination');
      pagination.innerHTML = '';
      if (totalPages > 1) {
        for (let i = 1; i <= totalPages; i++) {
          const btn = document.createElement('button');
          btn.innerText = i;
          btn.style.padding = '4px 10px';
          btn.style.background = i === currentPage ? '#3b82f6' : '#253244';
          btn.style.color = '#fff';
          btn.style.border = 'none';
          btn.style.borderRadius = '4px';
          btn.style.cursor = 'pointer';
          btn.onclick = () => {
            currentPage = i;
            renderTable();
          };
          pagination.appendChild(btn);
        }
      }
    }

    function sortTable(colIndex) {
      const tbody = document.getElementById('task-tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      if (rows.length === 0 || rows[0].cells.length < 5) return;
      
      if (currentSortCol === colIndex) {
        currentSortAsc *= -1;
      } else {
        currentSortCol = colIndex;
        currentSortAsc = 1;
      }

      rows.sort((a, b) => {
        let valA = a.cells[colIndex].innerText.trim();
        let valB = b.cells[colIndex].innerText.trim();
        if (valA === '') valA = 'ZZZZ';
        if (valB === '') valB = 'ZZZZ';
        return valA.localeCompare(valB) * currentSortAsc;
      });

      rows.forEach(row => tbody.appendChild(row));
      currentPage = 1;
      renderTable();
    }

    document.addEventListener('DOMContentLoaded', () => {
      renderTable();
    });
  </script>
</body>
</html>`;
    }

    private taskRow(task: any): string {
        const link = task.tapd_url || "";
        const linkHtml = link ? `<a href='${escapeHtml(link)}' target='_blank' rel='noopener noreferrer'>查看</a>` : "";
        const statusRaw = task.status || "";
        const statusLabel = STATUS_LABELS[statusRaw] || statusRaw;
        return (
            "<tr>" +
            `<td>${escapeHtml(task.title || '')}</td>` +
            `<td>${escapeHtml(task.primary_owner_name || '')}</td>` +
            `<td>${escapeHtml((task.assignee_names || []).join('、'))}</td>` +
            `<td><span class='pill pill-${escapeHtml(statusRaw)}'>${escapeHtml(statusLabel)}</span></td>` +
            `<td>${escapeHtml(task.priority || '')}</td>` +
            `<td>${escapeHtml(task.due_date || '')}</td>` +
            `<td>${linkHtml}</td>` +
            "</tr>"
        );
    }

    private issueRow(item: any): string {
        return (
            "<tr>" +
            `<td>${escapeHtml(item.title || '')}</td>` +
            `<td>${escapeHtml(item.owner || '')}</td>` +
            `<td>${escapeHtml(item.impact || '')}</td>` +
            `<td>${escapeHtml(item.action || '')}</td>` +
            "</tr>"
        );
    }

    private sortTasks(tasks: any[]): any[] {
        return tasks.sort((a, b) => {
            const rA = [STATUS_SORT[a.status] ?? 9, PRIORITY_SORT[a.priority || "P2"] ?? 5, a.due_date || "9999-12-31", a.updated_at || ""];
            const rB = [STATUS_SORT[b.status] ?? 9, PRIORITY_SORT[b.priority || "P2"] ?? 5, b.due_date || "9999-12-31", b.updated_at || ""];
            for (let i = 0; i < 4; i++) {
                if (rA[i] < rB[i]) return -1;
                if (rA[i] > rB[i]) return 1;
            }
            return 0;
        });
    }

    private statusDistribution(tasks: any[]): any[] {
        const counts = tasks.reduce((acc, t) => {
            const st = t.status || "unknown";
            acc[st] = (acc[st] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
        
        return Object.keys(counts).sort((a, b) => (STATUS_SORT[a] ?? 9) - (STATUS_SORT[b] ?? 9)).map(st => ({
            status: st,
            label: STATUS_LABELS[st] || st,
            count: counts[st]
        }));
    }

    private buildBlockers(tasks: any[], standups: any[]): any[] {
        const values: any[] = [];
        for (const task of tasks) {
            if (task.status !== "blocked" || !this.blockedLongEnough(task)) continue;
            const blocker = task.blocker_info || {};
            values.push({
                title: blocker.reason || task.title || "",
                owner: blocker.blocked_by_name || task.primary_owner_name || "",
                impact: "任务阻塞超过 24 小时",
                action: blocker.suggested_action || "确认协助人和下一步恢复动作"
            });
        }
        for (const item of standups) {
            for (const blocker of (item.blockers || [])) {
                values.push({
                    title: blocker,
                    owner: item.user_name || "",
                    impact: "站会暴露协助需求",
                    action: "当天确认协助对象和处理时限"
                });
            }
        }
        return values;
    }

    private buildRisks(tasks: any[], standups: any[]): any[] {
        const values = tasks
            .filter(t => t.status === "overdue" || (t.status === "blocked" && this.blockedLongEnough(t)))
            .map(t => ({
                title: t.title || "",
                owner: t.primary_owner_name || "",
                impact: `任务状态：${STATUS_LABELS[t.status] || t.status}`,
                action: "确认是否需要调整计划或资源"
            }));
            
        for (const item of standups) {
            for (const risk of (item.risks || [])) {
                values.push({
                    title: risk,
                    owner: item.user_name || "",
                    impact: "站会提出延期或交付风险",
                    action: "确认风险等级和缓解动作"
                });
            }
        }
        return values;
    }

    private buildStandupSummary(standups: any[]): any {
        return {
            submitted: standups.length,
            today_plan: standups.flatMap(s => s.today_plan || []),
            blockers: standups.flatMap(s => s.blockers || []),
            decisions_needed: standups.flatMap(s => s.decisions_needed || []),
        };
    }

    private blockedLongEnough(task: any): boolean {
        if (!task.blocked_at) return false;
        const blockedAt = dayjs(task.blocked_at.replace("Z", ""));
        if (!blockedAt.isValid()) return false;
        return dayjs().diff(blockedAt, 'hour') >= 24;
    }
}
