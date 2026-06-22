from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional


TASK_STATUS_PENDING_PRIMARY_OWNER = "pending_primary_owner"
TASK_STATUS_PENDING_CONFIRMATION = "pending_confirmation"
TASK_STATUS_CONFIRMED = "confirmed"
TASK_STATUS_IN_PROGRESS = "in_progress"
TASK_STATUS_BLOCKED = "blocked"
TASK_STATUS_OWNER_MARKED_DONE = "owner_marked_done"
TASK_STATUS_ACCEPTED = "accepted"
TASK_STATUS_CANCELLED = "cancelled"
TASK_STATUS_OVERDUE = "overdue"


def to_dict(value: Any) -> Dict[str, Any]:
    return asdict(value)


@dataclass
class Member:
    open_id: str
    name: str
    role: str = ""
    is_active: bool = True


@dataclass
class Mention:
    open_id: str
    name: str


@dataclass
class SourceMessage:
    id: str
    chat_id: str
    chat_type: str
    sender_open_id: str
    sender_name: str
    text: str
    message_type: str
    sent_at: str
    raw_payload: Dict[str, Any]
    mentions: List[Mention] = field(default_factory=list)
    ai_result: Dict[str, Any] = field(default_factory=dict)
    confidence: Optional[float] = None
    parent_id: Optional[str] = None
    root_id: Optional[str] = None


@dataclass
class Task:
    id: str
    title: str
    creator_open_id: str
    creator_name: str
    primary_owner_open_id: str
    primary_owner_name: str
    assignee_open_ids: List[str]
    assignee_names: List[str]
    status: str
    priority: str
    source_message_id: str
    source_group_id: str
    created_at: str
    updated_at: str
    source_sender_open_id: str = ""
    source_sender_name: str = ""
    source_sent_at: str = ""
    raw_text: str = ""
    ai_result: Dict[str, Any] = field(default_factory=dict)
    confidence: Optional[float] = None
    trace: Dict[str, Any] = field(default_factory=dict)
    description: str = ""
    due_date: Optional[str] = None
    acceptance_criteria: List[str] = field(default_factory=list)
    dependencies: List[str] = field(default_factory=list)
    related_links: List[str] = field(default_factory=list)
    tags: List[str] = field(default_factory=list)
    task_plan: Dict[str, Any] = field(default_factory=dict)
    tapd_story_id: Optional[str] = None
    tapd_url: Optional[str] = None
    parent_id: Optional[str] = None
    is_draft: bool = False


@dataclass
class TaskUpdate:
    id: str
    task_id: str
    user_open_id: str
    user_name: str
    update_type: str
    content: str
    source: str
    source_message_id: Optional[str]
    created_at: str
    source_group_id: str = ""
    source_sender_open_id: str = ""
    source_sender_name: str = ""
    source_sent_at: str = ""
    raw_text: str = ""
    ai_result: Dict[str, Any] = field(default_factory=dict)
    confidence: Optional[float] = None
    trace: Dict[str, Any] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Standup:
    id: str
    open_id: str
    user_name: str
    date: str
    yesterday_done: List[str]
    today_plan: List[str]
    blockers: List[str]
    risks: List[str]
    decisions_needed: List[str]
    submitted_at: str
    source_message_id: Optional[str] = None
    source_group_id: str = ""
    source_sender_open_id: str = ""
    source_sender_name: str = ""
    source_sent_at: str = ""
    raw_text: str = ""
    ai_result: Dict[str, Any] = field(default_factory=dict)
    confidence: Optional[float] = None
    trace: Dict[str, Any] = field(default_factory=dict)


@dataclass
class DailySummary:
    id: str
    group_id: str
    date: str
    highlights: List[str]
    tasks: List[Dict[str, Any]]
    progress_updates: List[Dict[str, Any]]
    blockers: List[Dict[str, Any]]
    decisions: List[Dict[str, Any]]
    risks: List[Dict[str, Any]]
    shares: List[Dict[str, Any]]
    created_at: str
    ai_abstract: Optional[str] = None


@dataclass
class DashboardArtifact:
    id: str
    date: str
    html_path: str
    stats_path: str
    created_at: str
    public_url: Optional[str] = None


@dataclass
class BotMessageContext:
    message_id: str
    context_type: str
    created_at: str
    chat_id: str = ""
    target_open_id: Optional[str] = None
    task_id: Optional[str] = None
    task_title: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


def utc_now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
