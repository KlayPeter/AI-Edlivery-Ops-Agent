import axios from 'axios';
import { TapdConfig } from '../core/config';

export interface TapdResult {
    ok: boolean;
    raw: any;
    story_id?: string;
    url?: string;
    error?: string;
}

export class TapdAdapter {
    private config: TapdConfig;
    private dryRun: boolean;

    constructor(config: TapdConfig, dryRun: boolean = false) {
        this.config = config;
        this.dryRun = dryRun;
    }

    async createStory(
        title: string,
        owner: string,
        priority_label: string,
        due_date: string | null,
        description: string,
        parent_id?: string | null
    ): Promise<TapdResult> {
        const payload: any = {
            workspace_id: this.config.workspace_id,
            name: title,
            entity_type: "stories",
            workitem_type_id: this.config.workitem_type_id,
            status: "planning",
            owner,
            priority_label,
            description,
        };
        if (due_date) payload.due = due_date;
        if (parent_id) payload.parent_id = parent_id;

        if (this.dryRun) {
            const fakeId = `dry-${Math.floor(Math.random() * 1000000000)}`;
            return {
                ok: true,
                raw: { dry_run: true, payload, data: { Story: { id: fakeId } } },
                story_id: fakeId,
                url: this.storyUrl(fakeId)
            };
        }

        const result = await this._post("/stories?s=mcp", payload);
        const storyId = this._extractStoryId(result.raw);
        if (result.ok && storyId) {
            result.story_id = storyId;
            result.url = this.storyUrl(storyId);
        }
        return result;
    }

    async updateStoryStatus(storyId: string, status: string): Promise<TapdResult> {
        const payload = {
            workspace_id: this.config.workspace_id,
            id: storyId,
            entity_type: "stories",
            status
        };
        if (this.dryRun) {
            return { ok: true, raw: { dry_run: true, payload }, story_id: storyId, url: this.storyUrl(storyId) };
        }
        return this._post("/stories?s=mcp", payload);
    }

    async updateStoryDueDate(storyId: string, dueDate: string): Promise<TapdResult> {
        const payload = {
            workspace_id: this.config.workspace_id,
            id: storyId,
            entity_type: "stories",
            due: dueDate
        };
        if (this.dryRun) {
            return { ok: true, raw: { dry_run: true, payload }, story_id: storyId, url: this.storyUrl(storyId) };
        }
        return this._post("/stories?s=mcp", payload);
    }

    async updateStoryPriority(storyId: string, priorityLabel: string): Promise<TapdResult> {
        const payload = {
            workspace_id: this.config.workspace_id,
            id: storyId,
            entity_type: "stories",
            priority_label: priorityLabel
        };
        if (this.dryRun) {
            return { ok: true, raw: { dry_run: true, payload }, story_id: storyId, url: this.storyUrl(storyId) };
        }
        return this._post("/stories?s=mcp", payload);
    }

    async updateStoryOwner(storyId: string, owner: string): Promise<TapdResult> {
        const payload = {
            workspace_id: this.config.workspace_id,
            id: storyId,
            entity_type: "stories",
            owner
        };
        if (this.dryRun) {
            return { ok: true, raw: { dry_run: true, payload }, story_id: storyId, url: this.storyUrl(storyId) };
        }
        return this._post("/stories?s=mcp", payload);
    }

    storyUrl(storyId: string): string {
        return `https://www.tapd.cn/${this.config.workspace_id}/prong/stories/view/${storyId}`;
    }

    private async _post(path: string, payload: any): Promise<TapdResult> {
        const url = `${this.config.api_base.replace(/\/$/, '')}${path}`;
        try {
            const resp = await axios.post(url, payload, {
                headers: {
                    "Authorization": `Bearer ${this.config.api_token}`,
                    "Content-Type": "application/json",
                    "Via": "mcp"
                },
                timeout: 60000
            });
            return { ok: true, raw: resp.data };
        } catch (error: any) {
            if (axios.isAxiosError(error) && error.response) {
                const body = error.response.data;
                return { ok: false, raw: { body }, error: `HTTP ${error.response.status}: ${JSON.stringify(body)}` };
            }
            return { ok: false, raw: {}, error: String(error) };
        }
    }

    private _extractStoryId(raw: any): string | undefined {
        const data = raw?.data;
        if (typeof data === 'object' && data !== null) {
            const story = data.Story || data.story || data;
            if (typeof story === 'object' && story !== null && story.id) {
                return String(story.id);
            }
        }
        return undefined;
    }
}
