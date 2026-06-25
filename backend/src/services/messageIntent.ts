import { LLMAdapter } from '@/adapters/llm';
import { Member, SourceMessage } from '@/models/types';
import dayjs from 'dayjs';

export const SUPPORTED_INTENTS = new Set(["update_task", "create_task", "add_progress", "change_status", "unknown"]);
export const SUPPORTED_STATUS_ACTIONS = new Set(["接受", "拒绝", "需要澄清", "验收通过", "打回", "已完成", "完成了", "阻塞", "阻塞了"]);
export const SUPPORTED_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);

export interface IntentTaskRef {
    task_id: string;
    tapd_story_id: string;
    title: string;
}

export interface IntentFields {
    title: string;
    due_date: string;
    priority: string;
    owner_open_id: string;
    progress: string;
    status_action: string;
}

export interface MessageIntent {
    intent: string;
    confidence: number;
    task_ref: IntentTaskRef;
    fields: IntentFields;
    needs_clarification: boolean;
    clarification: string;
    error: string;
    available: boolean;
}

export class MessageIntentParser {
    public llm?: LLMAdapter;

    constructor(llm?: LLMAdapter) {
        this.llm = llm;
    }

    async parse(
        message: SourceMessage,
        replyContext: Record<string, any> | null,
        taskContext: Record<string, any> | null,
        members: Member[],
        today: Date = new Date()
    ): Promise<MessageIntent> {
        const payload = {
            today: dayjs(today).format('YYYY-MM-DD'),
            message: {
                id: message.id,
                chat_type: message.chat_type,
                sender_open_id: message.sender_open_id,
                sender_name: message.sender_name,
                text: message.text,
                mentions: (message.mentions || []).map(item => ({ open_id: item.open_id, name: item.name })),
            },
            reply_context: this.compactReplyContext(replyContext),
            task_context: this.compactTask(taskContext),
            members: members.filter(m => m.is_active).map(m => ({ open_id: m.open_id, name: m.name, role: m.role })),
        };
        
        const result = await this.llm.chat(this.systemPrompt(), JSON.stringify(payload));
        if (!result.ok) {
            return this.errorIntent(result.error || "llm_error");
        }
        if (!result.content.trim()) {
            return this.errorIntent("llm_unavailable");
        }
        
        let raw: any;
        try {
            raw = JSON.parse(this.extractJson(result.content));
        } catch (exc: any) {
            return this.errorIntent(`invalid_json: ${exc.message}`);
        }
        return this.normalize(raw);
    }

    private errorIntent(error: string): MessageIntent {
        return {
            intent: "unknown",
            confidence: 0.0,
            task_ref: { task_id: "", tapd_story_id: "", title: "" },
            fields: { title: "", due_date: "", priority: "", owner_open_id: "", progress: "", status_action: "" },
            needs_clarification: false,
            clarification: "",
            error,
            available: false
        };
    }

    private systemPrompt(): string {
        return (
            "你是研发交付飞书机器人的意图解析器。只输出 JSON，不要 Markdown。\n" +
            "根据输入消息、引用上下文、任务上下文和成员列表，判断用户意图并抽取字段。\n" +
            "只能使用这些 intent: update_task, create_task, add_progress, change_status, unknown。\n" +
            "输出格式必须是：" +
            "{\"intent\":\"update_task|create_task|add_progress|change_status|unknown\"," +
            "\"confidence\":0.0," +
            "\"task_ref\":{\"task_id\":\"\",\"tapd_story_id\":\"\",\"title\":\"\"}," +
            "\"fields\":{\"title\":\"\",\"due_date\":\"YYYY-MM-DD\",\"priority\":\"P0|P1|P2|P3\"," +
            "\"owner_open_id\":\"\",\"progress\":\"\",\"status_action\":\"接受|拒绝|需要澄清|验收通过|打回|已完成|阻塞\"}," +
            "\"needs_clarification\":false,\"clarification\":\"\"}。\n" +
            "高置信度只在任务和字段都明确时给出；如果需要确认或任务不明确，needs_clarification=true 并给出中文澄清。"
        );
    }

    private extractJson(content: string): string {
        const text = content.trim();
        const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
        if (fenced) return fenced[1];
        
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start >= 0 && end >= start) return text.substring(start, end + 1);
        return text;
    }

    private normalize(raw: any): MessageIntent {
        let intent = typeof raw.intent === 'string' ? raw.intent : "unknown";
        if (!SUPPORTED_INTENTS.has(intent)) intent = "unknown";
        
        let confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.0;
        confidence = Math.max(0.0, Math.min(confidence, 1.0));

        const taskRefRaw = typeof raw.task_ref === 'object' && raw.task_ref ? raw.task_ref : {};
        const fieldsRaw = typeof raw.fields === 'object' && raw.fields ? raw.fields : {};

        let priority = this.str(fieldsRaw.priority).toUpperCase();
        if (!SUPPORTED_PRIORITIES.has(priority)) priority = "";
        
        let statusAction = this.str(fieldsRaw.status_action);
        if (!SUPPORTED_STATUS_ACTIONS.has(statusAction)) statusAction = "";

        return {
            intent,
            confidence,
            task_ref: {
                task_id: this.str(taskRefRaw.task_id),
                tapd_story_id: this.str(taskRefRaw.tapd_story_id),
                title: this.str(taskRefRaw.title),
            },
            fields: {
                title: this.str(fieldsRaw.title),
                due_date: this.str(fieldsRaw.due_date),
                priority,
                owner_open_id: this.str(fieldsRaw.owner_open_id),
                progress: this.str(fieldsRaw.progress),
                status_action: statusAction,
            },
            needs_clarification: !!raw.needs_clarification,
            clarification: this.str(raw.clarification),
            error: "",
            available: true
        };
    }

    private compactReplyContext(context: Record<string, any> | null): Record<string, any> | null {
        if (!context) return null;
        return {
            context_type: context.context_type || "",
            task_id: context.task_id || "",
            task_title: context.task_title || "",
            target_open_id: context.target_open_id || "",
            metadata: context.metadata || {},
        };
    }

    private compactTask(task: Record<string, any> | null): Record<string, any> | null {
        if (!task) return null;
        return {
            id: task.id || "",
            title: task.title || "",
            tapd_story_id: task.tapd_story_id || "",
            primary_owner_open_id: task.primary_owner_open_id || "",
            primary_owner_name: task.primary_owner_name || "",
            priority: task.priority || "",
            due_date: task.due_date || "",
            status: task.status || "",
        };
    }

    private str(value: any): string {
        return typeof value === 'string' ? value.trim() : "";
    }
}
