const isProd = process.env.NODE_ENV === 'production';

/** Whether email can actually be delivered right now. Dev mode always "sends" (console log), so this only bites in production. */
export function isEmailConfigured(): boolean {
  if (!isProd) return true;
  return Boolean(process.env.EMAIL_FROM && process.env.RESEND_API_KEY);
}

/** Shared Resend send — dev mode logs instead of sending. */
async function sendEmail(to: string, subject: string, html: string, text: string, devLogLabel: string): Promise<void> {
  if (!isProd) {
    console.log(`[EmailService] DEV MODE — ${devLogLabel} for ${to}:`);
    console.log(`  ${text}`);
    return;
  }

  const from = process.env.EMAIL_FROM;
  const apiKey = process.env.RESEND_API_KEY;
  if (!from || !apiKey) {
    throw new Error('EMAIL_FROM / RESEND_API_KEY not configured');
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}

export async function sendMagicLinkEmail(email: string, token: string): Promise<void> {
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
  const approveUrl = `${appUrl}/approve?token=${token}`;

  await sendEmail(
    email,
    'Idle Party RPG — Sign In',
    `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2>Sign in to Idle Party RPG</h2>
        <p>Click the button below to sign in. This link expires in 15 minutes.</p>
        <a href="${approveUrl}" style="display: inline-block; padding: 12px 24px; background: #d4a017; color: #1a0a2e; text-decoration: none; border-radius: 4px; font-weight: bold;">
          Sign In
        </a>
        <p style="margin-top: 24px; font-size: 12px; color: #888;">
          If you didn't request this, you can safely ignore this email.
        </p>
      </div>
    `,
    `Sign in to Idle Party RPG:\n\n${approveUrl}\n\nThis link expires in 15 minutes. If you didn't request this, you can safely ignore this email.`,
    'magic link',
  );

  console.log(`[EmailService] Magic link sent to ${email}`);
}

/** Generic notification email — used by the notification framework's email channel driver. */
export async function sendNotificationEmail(email: string, title: string, body: string): Promise<void> {
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000';

  await sendEmail(
    email,
    `Idle Party RPG — ${title}`,
    `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2>${title}</h2>
        <p>${body}</p>
        <a href="${appUrl}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #d4a017; color: #1a0a2e; text-decoration: none; border-radius: 4px; font-weight: bold;">
          Open Idle Party RPG
        </a>
        <p style="margin-top: 24px; font-size: 12px; color: #888;">
          You're receiving this because you enabled email notifications for this event. Manage this in Settings → Notifications.
        </p>
      </div>
    `,
    `${title}\n\n${body}\n\n${appUrl}`,
    'notification email',
  );
}
