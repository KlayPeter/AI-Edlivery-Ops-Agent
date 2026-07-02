import * as fs from 'fs';
import * as path from 'path';
import mammoth from 'mammoth';
import { HandlerContext } from '../types';
import { ContextResolver } from '../ContextResolver';
import { SourceMessage, utcNowIso } from '@/models/types';

export class MeetingSummaryHandler {
    static async maybeHandle(ctx: HandlerContext, message: SourceMessage, source: "group" | "private"): Promise<any> {
        const botMentioned = (message.mentions || []).some(m => m.open_id === ctx.config.feishu.bot_open_id);
        const shouldConsider = source === "private" || botMentioned;
        if (!shouldConsider) return null;

        const text = message.text || "";
        const isTarget = ["整理纪要", "整理会议", "会议纪要", "生成会议纪要", "生成纪要"].some(k => text.includes(k));
        if (!isTarget) return null;

        await ctx.feishu.addReaction(message.id, "OnIt");

        let targetChatId = message.chat_id;
        if (source === "private") {
            targetChatId = (await ctx.store.openIdForChatId(message.sender_open_id)) || message.sender_open_id;
        }

        // Use context resolver to get related files
        const resolver = new ContextResolver(ctx);
        const relatedFiles = await resolver.resolveRelatedFiles(message);
        
        // If the user sent the files as separate messages before invoking the bot,
        // we can fetch the recent messages from the same user in this chat to find the files.
        if (relatedFiles.length < 2) {
            const recentMsgs = await ctx.store.prisma.sourceMessage.findMany({
                where: {
                    chat_id: message.chat_id,
                    sender_open_id: message.sender_open_id,
                },
                take: 20
            });

            // Sort manually since sent_at could be ISO or ms string
            recentMsgs.sort((a: any, b: any) => {
                const ta = /^\d+$/.test(a.sent_at) ? parseInt(a.sent_at, 10) : new Date(a.sent_at).getTime();
                const tb = /^\d+$/.test(b.sent_at) ? parseInt(b.sent_at, 10) : new Date(b.sent_at).getTime();
                return tb - ta;
            });

            const nowMs = Date.now();
            
            // Check if user explicitly asked for N files (e.g., "上面两个文件", "上面3个文件")
            const explicitMatch = message.text?.match(/上面(\d+|[一二两三四五六七八九十])个文件/);
            let explicitCount = 0;
            if (explicitMatch) {
                const numStr = explicitMatch[1];
                const zhNumMap: Record<string, number> = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
                explicitCount = zhNumMap[numStr] || parseInt(numStr, 10);
            }

            for (const msg of recentMsgs) {
                if (explicitCount > 0 && relatedFiles.length >= explicitCount) {
                    break; // Stop if we have collected the explicitly requested number of files
                }
                const msgTime = /^\d+$/.test(msg.sent_at) ? parseInt(msg.sent_at, 10) : new Date(msg.sent_at).getTime();
                
                if (msg.file_key || msg.image_key) {
                    let isValidFile = false;
                    
                    if (explicitCount > 0) {
                        // Bypass all restrictions if user explicitly specified a count
                        isValidFile = true;
                    } else if (nowMs - msgTime < 3 * 60 * 1000) {
                        // Normal logic: within 3 minutes and matching keywords/extensions
                        if (msg.image_key) {
                            isValidFile = true;
                        } else if (msg.file_key && msg.raw_payload) {
                            try {
                                const payload = JSON.parse(msg.raw_payload);
                                const eventMsg = payload.event?.message || payload.message;
                                if (eventMsg && eventMsg.content) {
                                    const content = JSON.parse(eventMsg.content);
                                    if (content.file_name) {
                                        const ext = content.file_name.toLowerCase();
                                        if (ext.endsWith('.docx') || ext.endsWith('.md')) {
                                            const keywords = ["转写", "洞察", "纪要", "总结", "分享"];
                                            if (keywords.some(kw => content.file_name.includes(kw))) {
                                                isValidFile = true;
                                            }
                                        }
                                    }
                                }
                            } catch (e) {}
                        }
                        // Fallback if parsing fails but we have a file_key
                        if (msg.file_key && !msg.raw_payload) isValidFile = true;
                    }

                    if (isValidFile) {
                        const exists = relatedFiles.find((f: any) => f.fileKey === msg.file_key || f.imageKey === msg.image_key);
                        if (!exists) {
                            relatedFiles.push({ fileKey: msg.file_key, imageKey: msg.image_key, messageId: msg.id });
                        }
                    }
                }
            }
        }
        
        if (relatedFiles.length === 0) {
            await ctx.feishu.sendReplyText(message.id, "没有找到相关的文件附件（请回复包含转写docx/md的文件消息，或在同一条消息中上传文件）");
            await ctx.feishu.removeReaction(message.id, "OnIt");
            return { handled: true, action: "meeting_summary_no_files" };
        }

        await ctx.feishu.sendReplyText(message.id, "⏳ 正在阅读材料并生成两份纪要，可能需要几分钟，请稍候...");

        const tempDir = path.join(ctx.config.data_path, "temp");
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        let transcriptText = "";
        let insightText = "";

        for (let i = 0; i < relatedFiles.length; i++) {
            const file = relatedFiles[i] as any;
            const fileKey = file.fileKey || file.imageKey;
            const isImage = !!file.imageKey;
            const fileMessageId = file.messageId || message.id;
            if (!fileKey) continue;
            
            const ext = isImage ? ".png" : (file.fileKey ? ".docx" : ".tmp"); 
            const localPath = path.join(tempDir, `file_${message.id}_${i}${ext}`);
            const downloaded = await ctx.feishu.downloadResource(fileMessageId, fileKey, isImage ? 'image' : 'file', localPath);
            
            if (downloaded && !isImage) {
                try {
                    const result = await mammoth.extractRawText({ path: localPath });
                    if (result.value && result.value.trim().length > 0) {
                        transcriptText += result.value + "\n";
                    } else {
                        insightText += fs.readFileSync(localPath, 'utf-8') + "\n";
                    }
                } catch (e) {
                    try {
                        insightText += fs.readFileSync(localPath, 'utf-8') + "\n";
                    } catch (e2) {}
                }
            }
        }

        if (!transcriptText && !insightText) {
            await ctx.feishu.sendReplyText(message.id, "❌ 未能成功读取文件内容，可能格式不支持或文件损坏。");
            return { handled: true, action: "meeting_summary_read_failed" };
        }

        const prompt = `
你是一个AI会议整理专家。你的任务是根据提供的【会议转写文本】和【会议洞察笔记】，生成两份专业的文档。

输入材料：
【会议转写文本】
${transcriptText || "(无)"}

【会议洞察笔记】
${insightText || "(无)"}

请严格按以下格式输出结果，必须包含这三个分隔符，不要输出多余的引导语：

---THEME---
(请在此处输出一句话，不超过15个字，提取本次会议的核心主题)

---MEETING SUMMARY---
(请在此处输出《会议总结.md》的内容，要求：包含会议背景、核心决策、核心待办、风险与阻碍，使用专业的业务语言，去除口语化和无效信息)

---TIMELINE---
(请在此处输出《时间线与会议洞察整合版.md》的内容，要求：按时间线梳理会议进展，并把洞察笔记对应融合进去，提供一个逻辑清晰的故事线)
`;

        let themeStr = "未命名会议";
        let summaryMd = "";
        let timelineMd = "";

        if (ctx.intentParser) {
            const aiResponse = await ctx.intentParser.llm.chat(prompt, "");
            const content = aiResponse.content || "";
            
            const themeMatch = content.match(/---THEME---\s*([\s\S]*?)\s*---MEETING SUMMARY---/i);
            const summaryMatch = content.match(/---MEETING SUMMARY---\s*([\s\S]*?)\s*---TIMELINE---/i);
            const timelineMatch = content.match(/---TIMELINE---\s*([\s\S]*)$/i);
            
            if (themeMatch) themeStr = themeMatch[1].trim().replace(/[\/\\]/g, '-');
            if (summaryMatch) summaryMd = summaryMatch[1].trim();
            if (timelineMatch) timelineMd = timelineMatch[1].trim();
            
            if (!summaryMd && !timelineMd) {
                summaryMd = content; // fallback
            }
        } else {
            summaryMd = "AI不可用。";
            timelineMd = "AI不可用。";
        }

        const baseSummariesDir = path.join(ctx.config.data_path, "summaries");
        const dateStr = new Date().toISOString().split('T')[0];
        const timeStr = new Date().toISOString().split('T')[1].replace(/[:.]/g, '').substring(0, 6);
        const folderName = `${dateStr}_${timeStr}_${themeStr}`;
        const summariesDir = path.join(baseSummariesDir, folderName);
        if (!fs.existsSync(summariesDir)) fs.mkdirSync(summariesDir, { recursive: true });

        const sumName = `会议总结_${dateStr}.md`;
        const tlName = `时间线与会议洞察整合版_${dateStr}.md`;
        const summaryPath = path.join(summariesDir, sumName);
        const timelinePath = path.join(summariesDir, tlName);
        
        const summaryRelPath = path.join(folderName, sumName);
        const timelineRelPath = path.join(folderName, tlName);

        fs.writeFileSync(summaryPath, summaryMd || "无内容", "utf-8");
        fs.writeFileSync(timelinePath, timelineMd || "无内容", "utf-8");

        let replyMsg = "✅ **纪要生成完成！** 请查看下方文档附件。\n";
        let emailHtml = "<h3>自动生成的会议纪要</h3><ul>";
        let emailSent = false;

        emailHtml += `<li>会议总结_${dateStr}.md</li>`;
        emailHtml += `<li>时间线与会议洞察整合版_${dateStr}.md</li>`;
        emailHtml += "</ul><p>详见附件内容。</p>";

        if (ctx.email) {
            const emailRes = await ctx.email.sendEmail(
                `会议纪要自动推送 - ${dateStr}`,
                emailHtml,
                [
                    { filename: sumName, path: summaryPath },
                    { filename: tlName, path: timelinePath }
                ]
            );
            if (emailRes.ok) {
                replyMsg += "\n📧 邮件已成功发送至相关人员！";
                emailSent = true;
            } else {
                replyMsg += `\n⚠️ 邮件发送失败: ${emailRes.error}`;
            }
        }

        await ctx.store.saveMeetingSummaryRecord({
            id: message.id + "_" + Date.now(),
            date: dateStr,
            group_id: message.chat_id,
            source_message_id: message.id,
            theme: themeStr,
            summary_file: summaryRelPath,
            timeline_file: timelineRelPath,
            email_sent: emailSent,
            created_at: new Date().toISOString()
        });

        await ctx.feishu.sendReplyText(message.id, replyMsg);
        await ctx.feishu.sendReplyFile(message.id, summaryPath);
        await ctx.feishu.sendReplyFile(message.id, timelinePath);
        await ctx.feishu.removeReaction(message.id, "OnIt");
        
        return { handled: true, action: "meeting_summary" };
    }
}
