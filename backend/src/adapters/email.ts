import nodemailer from 'nodemailer';
import { EmailConfig } from '@/core/config';

export interface EmailAttachment {
    filename: string;
    path?: string;
    content?: string | Buffer;
}

export class EmailAdapter {
    private config: EmailConfig;
    private transporter: nodemailer.Transporter | null = null;
    public dryRun: boolean;

    constructor(config: EmailConfig, dryRun: boolean = false) {
        this.config = config;
        this.dryRun = dryRun;
        this._initTransporter();
    }

    private _initTransporter() {
        if (!this.config.enabled || !this.config.host || !this.config.user) {
            return;
        }
        this.transporter = nodemailer.createTransport({
            host: this.config.host,
            port: this.config.port,
            secure: this.config.secure,
            auth: {
                user: this.config.user,
                pass: this.config.pass
            }
        });
    }

    async sendEmail(
        subject: string,
        htmlContent: string,
        attachments: EmailAttachment[] = [],
        toAddresses?: string[]
    ): Promise<{ ok: boolean; error?: string }> {
        const recipients = toAddresses && toAddresses.length > 0 
            ? toAddresses 
            : this.config.to_addresses;

        if (!recipients || recipients.length === 0) {
            return { ok: false, error: 'No recipients provided or configured in email config.' };
        }

        const mailOptions = {
            from: this.config.from_address || this.config.user,
            to: recipients.join(', '),
            subject,
            html: htmlContent,
            attachments
        };

        if (this.dryRun) {
            console.log(`[EmailAdapter] Dry run: Would send email to ${mailOptions.to} with subject "${subject}"`);
            return { ok: true };
        }

        if (!this.transporter) {
            return { ok: false, error: 'Email service is not enabled or not properly configured.' };
        }

        try {
            await this.transporter.sendMail(mailOptions);
            return { ok: true };
        } catch (e: any) {
            return { ok: false, error: e.message || String(e) };
        }
    }
}
