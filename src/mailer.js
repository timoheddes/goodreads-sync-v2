import { createTransport } from 'nodemailer';
import { SMTP_HOST, SMTP_PORT, SMTP_FROM } from './config.js';
import { logWarn, log, logError } from './logging.js';

const smtpTransport = createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  tls: { rejectUnauthorized: false },
});

export function buildEmailHtml(userName, books) {
  const bookRows = books.map(b => `
    <tr>
      <td style="padding: 12px 16px; border-bottom: 1px solid #f0f0f0;">
        <strong style="color: #1a1a1a;">${b.title || 'Unknown Title'}</strong>
        <br>
        <span style="color: #666; font-size: 14px;">${b.author || 'Unknown Author'}</span>
      </td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin: 0; padding: 0; background-color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 32px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background-color: #2d3748; padding: 28px 32px; text-align: center;">
              <span style="font-size: 28px;">📚</span>
              <h1 style="color: #ffffff; margin: 8px 0 0; font-size: 20px; font-weight: 600;">New books ready!</h1>
            </td>
          </tr>
          <!-- Greeting -->
          <tr>
            <td style="padding: 28px 32px 16px;">
              <p style="color: #333; font-size: 16px; margin: 0;">
                Hi ${userName},
              </p>
              <p style="color: #555; font-size: 15px; margin: 12px 0 0;">
                ${books.length === 1 ? 'A new book was' : `${books.length} new books were`} downloaded and ${books.length === 1 ? 'is' : 'are'} ready for you to read.
              </p>
            </td>
          </tr>
          <!-- Book list -->
          <tr>
            <td style="padding: 0 32px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #fafafa; border-radius: 8px; border: 1px solid #eee;">
                ${bookRows}
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding: 16px 32px 28px; text-align: center;">
              <p style="color: #999; font-size: 13px; margin: 0;">Happy reading!</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendDownloadNotification(user, books) {
  if (!user.email) return;
  if (!SMTP_FROM) {
    logWarn(`[Email] SMTP_FROM not configured — skipping email for ${user.name}`);
    return;
  }
  if (books.length === 0) return;

  const subject = books.length === 1
    ? `📚 "${books[0].title}" is ready to read`
    : `📚 ${books.length} new books are ready to read`;

  try {
    await smtpTransport.sendMail({
      from: SMTP_FROM,
      to: user.email,
      subject,
      html: buildEmailHtml(user.name, books),
    });
    log(`📧 [Email] Sent notification to ${user.name} (${user.email}): ${books.length} book(s)`);
  } catch (err) {
    logError(`[Email] Failed to send to ${user.name} (${user.email})`, err);
  }
}