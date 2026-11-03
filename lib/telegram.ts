import { config } from "./config";

export async function notify(text: string) {
  if (!config.telegramToken || !config.telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error("telegram error", e);
  }
}

export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
