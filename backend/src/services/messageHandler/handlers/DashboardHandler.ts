import { HandlerContext } from '../types';
import { SourceMessage } from '@/models/types';

export class DashboardHandler {
    static async maybeHandle(ctx: HandlerContext, message: SourceMessage, source: "group" | "private"): Promise<any> {
        if (source !== "group") return null;

        const text = message.text || "";
        if (text.includes("生成今日进度看板") || text.includes("生成看板") || text.includes("进度看板")) {
            const targetGroup = ctx.config.groups.find(g => g.chat_id === message.chat_id);
            if (!targetGroup) return { handled: true, reason: "unknown_group_for_dashboard" };
            
            const artifact = await ctx.dashboard.generateForGroup(targetGroup);
            const publish = await ctx.feishu.publishFile(artifact.html_path);
            
            if (publish.url) {
                artifact.public_url = publish.url;
                await ctx.store.saveDashboardArtifact(artifact);
            }
            
            let replyText = "";
            if (publish.ok && artifact.public_url) {
                replyText = `今日进度看板已生成：\n${artifact.public_url}`;
                if (publish.warning) replyText += `\n\n${publish.warning}`;
            } else if (publish.ok && publish.warning) {
                replyText = `今日进度看板已生成，但飞书云盘共享未配置完成：\n${publish.warning}\n本地文件：${artifact.html_path}`;
            } else if (publish.ok) {
                replyText = `今日进度看板已生成：\n${artifact.html_path}`;
            } else {
                replyText = `今日进度看板已生成，但飞书云盘发布失败：\n${ctx.feishu.explainError(publish)}\n本地文件：${artifact.html_path}`;
            }
            
            await ctx.feishu.sendReplyText(message.id, replyText);
            await ctx.store.appendAuditLog("dashboard_generated", { artifact_path: artifact.html_path, public_url: artifact.public_url });
            return { handled: true, action: "dashboard", artifact: artifact.html_path };
        }
        return null;
    }
}
