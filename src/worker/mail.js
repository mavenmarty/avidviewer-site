// Sends account email (sign-in links). The provider is chosen by which secret is set:
//   POSTMARK_TOKEN  → Postmark (https://api.postmarkapp.com/email)
//   RESEND_API_KEY  → Resend   (https://api.resend.com/emails)
// MAIL_FROM sets the sender (default "Avid Viewer <hello@avidviewer.app>").
// With neither secret, mailConfigured() is false: production refuses sign-in by email (passkeys still work),
// and local development (DEV_SHOW_LINKS = "1") returns the link in the API response instead of sending it.

export function mailConfigured(env) {
  return Boolean(env.POSTMARK_TOKEN || env.RESEND_API_KEY);
}

export async function sendMail(env, { to, subject, text, html }) {
  const from = env.MAIL_FROM || 'Avid Viewer <hello@avidviewer.app>';
  let r;
  if (env.POSTMARK_TOKEN) {
    r = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': env.POSTMARK_TOKEN },
      body: JSON.stringify({ From: from, To: to, Subject: subject, TextBody: text, HtmlBody: html, MessageStream: 'outbound' }),
    });
  } else if (env.RESEND_API_KEY) {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
    });
  } else {
    throw new Error('no mail provider configured');
  }
  if (!r.ok) throw new Error(`mail provider answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
