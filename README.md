# 🇦🇹 Austrian Embassy Appointment Watcher Bot 🤖📅

A Telegram bot that monitors visa appointment availability on the [Austrian Embassy appointment system](https://appointment.bmeia.gv.at/). It checks for available appointments and notifies you when earlier time slots become available.

---

## 🚀 Features

- ✅ Automatically checks for appointment availability every 5 minutes
- 📅 Tracks the earliest available appointment
- 🔔 Sends instant notifications when an earlier slot is found
- ⏱️ Timezone-aware scheduling (default: Africa/Nairobi)
- 💬 Simple Telegram interface with helpful commands
- 🛡️ Secure configuration via environment variables

---

## ⚙️ Requirements

- Node.js 18+
- A Telegram account
- A Telegram bot token ([Create one here](https://t.me/BotFather))
- Your personal Telegram `chat_id`

---

## 📦 Installation

1. **Clone the repo**:

```bash
git clone https://github.com/Ahmed9190/austrian-embassy-appointment-watcher.git
cd austrian-embassy-appointment-watcher
```

2. **Install dependencies**:

```bash
npm install
```

3. **Configure environment variables**:

Create a `.env` file in the root folder:

```env
BOT_TOKEN=your_telegram_bot_token
CHAT_ID=your_telegram_chat_id
# Optional: Set your timezone
TIMEZONE=Africa/Kigali
```

---

## ✅ Usage

### Start the bot:

```bash
node index.js
```

### On startup, it will:

- Send a confirmation message to your Telegram
- Start checking for appointments immediately
- Continue checking every 5 minutes

### Configuration Options:

You can modify these values in the `CONFIG` object in `index.js`:

- `EMBASSY_OFFICE`: Embassy location (default: "NAIROBI")
- `CALENDAR_ID`: Calendar ID for appointments (default: "2840814")
- `PERSON_COUNT`: Number of people (default: 1)
- `CHECK_INTERVAL`: Cron schedule for checks (default: every 5 minutes)

---

## 📲 Telegram Commands

| Command                       | Description                        |
| ----------------------------- | ---------------------------------- |
| `/set_appointment YYYY-MM-DD` | Set your current appointment date  |
| `/check_now`                  | Check for appointments immediately |
| `/current_appointment`        | Show your current appointment date |

---

## 💡 How It Works

1. The bot checks the Austrian Embassy appointment system every 5 minutes
2. It looks for available appointments and finds the earliest one
3. If an earlier appointment is found than your current one, it notifies you
4. The notification includes the date and time of the new appointment
5. You can set your current appointment using the `/set_appointment` command

---

## 👨‍💻 Developer Info

### Tech Stack

- **Node.js** — Runtime
- **Axios** — HTTP client for API requests
- **node-telegram-bot-api** — Telegram API wrapper
- **node-cron** — For scheduled checks
- **moment-timezone** — Timezone handling

### Folder Structure

```
.
├── index.js        # Main application logic
├── .env            # Environment variables
└── package.json    # Dependencies
```

---

## 🛡️ Safety & Limitations

- ✅ Designed for private use (your own chat ID only)
- 🚫 Never share your `.env` or bot token publicly
- ⚠️ The bot only notifies about earlier appointments, it doesn't book them automatically

---

## 🧪 Development

### Finding your Chat ID

To find your Telegram chat ID, you can use the [@userinfobot](https://t.me/userinfobot) on Telegram.

### Logs

- The bot logs all activities to the console
- Error messages include detailed information for debugging

---

## 📜 License

MIT – free for personal use and tinkering.
