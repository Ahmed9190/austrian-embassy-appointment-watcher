import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import moment from "moment-timezone";
import axios from "axios";
import dotenv from "dotenv";
import { Agent as HttpsAgent } from 'https'; // Import HttpsAgent for keepAlive
import fs from "fs"; // Import file system module
import path from "path"; // Import path module
import nodemailer from "nodemailer"; // Import nodemailer for email

dotenv.config();

// --- Constants ---
const APPOINTMENT_FILE = path.join(process.cwd(), 'appointment.json'); // File to save the USER's set appointment state

// --- Configuration ---
const CONFIG = {
  // Telegram
  BOT_TOKEN: process.env.BOT_TOKEN,
  CHAT_ID: process.env.CHAT_ID,

  // Appointment settings
  EMBASSY_OFFICE: "NAIROBI",
  CALENDAR_ID: "2840814",
  PERSON_COUNT: 1,

  // Timezone (use your local timezone, e.g., 'Africa/Nairobi')
  TIMEZONE: process.env.TIMEZONE,

  // Check frequency (every 5 minutes)
  CHECK_INTERVAL: "*/5 * * * *",
  // Headers to mimic the working curl command (from previous user input)
  HEADERS: {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9,de-DE;q=0.8,de;q=0.7,ar;q=0.6,tr;q=0.5',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Content-Type': 'application/x-www-form-urlencoded',
    // NOTE: The cookie value might need to be dynamic if the site requires a fresh session.
    // A dynamic session ID is generated per request in checkAppointments.
    'Origin': 'https://appointment.bmeia.gv.at',
    'Referer': 'https://appointment.bmeia.gv.at/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'Pragma': 'no-cache',
    'Accept-Encoding': 'gzip, deflate, br'
  },

  // Email Configuration (Requires environment variables EMAIL_SENDER, EMAIL_PASSWORD, EMAIL_RECIPIENT)
  EMAIL_SENDER: process.env.EMAIL_SENDER,
  EMAIL_PASSWORD: process.env.EMAIL_PASSWORD, // Use an App Password if using Gmail
  EMAIL_RECIPIENT: process.env.EMAIL_RECIPIENT,

  // Pushbullet Configuration (Requires environment variable PUSHBULLET_API_KEY)
  PUSHBULLET_API_KEY: process.env.PUSHBULLET_API_KEY,
  PUSHBULLET_API_BASE_URL: "https://api.pushbullet.com/v2",
};

// --- Helper Functions for Persistence ---

/**
 * Loads the saved appointment from file
 */
async function loadAppointment() {
  try {
    if (!fs.existsSync(APPOINTMENT_FILE)) {
      console.log('ℹ️ No saved appointment file found.');
      return null;
    }

    // Read and parse the file
    const fileContent = await fs.promises.readFile(APPOINTMENT_FILE, 'utf8');
    const data = JSON.parse(fileContent);

    // Ensure saved data has the expected structure and valid date
    if (!data || !data.fullDate) {
      console.log('ℹ️ No valid appointment data found in the file.');
      return null;
    }

    // Parse the date and create the appointment object
    // Use the timezone from the saved data or CONFIG.TIMEZONE
    const appointment = {
      fullDate: moment.tz(data.fullDate, data.timezone || CONFIG.TIMEZONE),
      time: data.time || '00:00', // Default time if not saved
      originalString: data.originalString || data.fullDate,
      savedAt: data.savedAt ? new Date(data.savedAt) : new Date(), // Parse savedAt if exists
      timezone: data.timezone || CONFIG.TIMEZONE // Save timezone used
    };
    // Validate the parsed date
    if (!appointment.fullDate.isValid()) {
      console.error(`❌ Loaded invalid date "${data.fullDate}" from file.`);
      return null;
    }

    console.log(`✅ Loaded saved appointment: ${appointment.fullDate.format('YYYY-MM-DD')} (${appointment.time})`);
    return appointment;

  } catch (error) {
    console.error('❌ Error loading appointment from', APPOINTMENT_FILE, ':', error.message);
    return null;
  }
}

/**
 * Saves the current appointment to a file
 */
async function saveAppointment(appointment) {
  if (!appointment) {
    console.log('No appointment to save.');
    return false;
  }
  try {
    // Ensure the directory exists
    await fs.promises.mkdir(path.dirname(APPOINTMENT_FILE), { recursive: true });

    // Prepare data for saving
    const data = {
      // Save date as ISO 8601 string for reliable parsing later
      fullDate: appointment.fullDate.toISOString(),
      time: appointment.time,
      originalString: appointment.originalString,
      savedAt: new Date().toISOString(), // Timestamp when saved
      timezone: CONFIG.TIMEZONE // Save the timezone used
    };

    // Write to file with proper error handling
    await fs.promises.writeFile(APPOINTMENT_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log(`✅ Saved appointment to ${APPOINTMENT_FILE}: ${appointment.fullDate.format('YYYY-MM-DD')}`);
    return true;
  } catch (error) {
    console.error(`❌ Error saving appointment to ${APPOINTMENT_FILE}:`, error);
    return false;
  }
}

// Initialize state
const state = {
  currentAppointment: null, // This will hold the USER's set appointment loaded from file
  isRunning: false, // Is a check currently running?
  isCleaningUp: false, // Is the script in the process of shutting down?
  bot: null, // Telegram bot instance
  botInitialized: false, // Flag to indicate if the bot is successfully initialized
  isBotInitializing: false // Flag to indicate if bot initialization is in progress
};

// Load saved appointment when starting
async function initializeAppointment() {
  try {
    const savedAppointment = await loadAppointment();
    if (savedAppointment) {
      state.currentAppointment = savedAppointment;
      console.log(`✅ Bot initialized with saved appointment: ${savedAppointment.fullDate.format('YYYY-MM-DD HH:mm')} (Timezone: ${CONFIG.TIMEZONE})`);
      return true;
    } else {
      console.log('ℹ️ Bot initialized with no saved appointment.');
      return false;
    }
  } catch (error) {
    console.error('❌ Error initializing appointment:', error);
    return false;
  }
}

// Initialize appointment when the script starts
initializeAppointment().catch(console.error);


// --- Environment Variable Validation ---
if (!CONFIG.BOT_TOKEN || !CONFIG.CHAT_ID) {
  console.error('Error: BOT_TOKEN and CHAT_ID environment variables are required');
  process.exit(1); // Exit if essential variables are missing
}
if (!CONFIG.TIMEZONE) {
  console.error('Error: TIMEZONE environment variable is required (e.g., \'Africa/Nairobi\')');
  process.exit(1);
} else {
  // Validate timezone string
  if (!moment.tz.zone(CONFIG.TIMEZONE)) {
    console.error(
      `Error: Invalid TIMEZONE specified: ${CONFIG.TIMEZONE}. Please use a valid IANA timezone name (e.g., 'Europe/Berlin').`
    );
    process.exit(1); // Exit if timezone is invalid
  }
}

// Check for email and Pushbullet variables, but allow running without them
const enableEmail = CONFIG.EMAIL_SENDER && CONFIG.EMAIL_PASSWORD && CONFIG.EMAIL_RECIPIENT;
const enablePushbullet = CONFIG.PUSHBULLET_API_KEY;

if (!enableEmail) {
  console.warn(
    "Warning: Email notifications are not fully configured (EMAIL_SENDER, EMAIL_PASSWORD, and EMAIL_RECIPIENT are required)."
  );
}
if (!enablePushbullet) {
  console.warn(
    "Warning: Pushbullet notifications are not configured (PUSHBULLET_API_KEY is required)."
  );
}

// --- Nodemailer Transporter (for email) ---
let transporter = null;
if (enableEmail) {
  transporter = nodemailer.createTransport({
    service: "gmail", // Or your email service provider
    auth: {
      user: CONFIG.EMAIL_SENDER,
      pass: CONFIG.EMAIL_PASSWORD, // Use an App Password if using Gmail
    },
  });
}

// --- Helper Functions ---

/**
 * Sends a message to Telegram
 */
async function sendMessage(text) {
  // Check if bot is initialized and chat ID is available before sending
  if (!state.botInitialized || !state.bot || !CONFIG.CHAT_ID) {
    console.error('Error: Telegram bot not fully initialized or CHAT_ID missing. Cannot send message.');
    // Optionally, log the message content if unable to send
    // console.error('Message content:', text);
    return;
  }
  try {
    await state.bot.sendMessage(CONFIG.CHAT_ID, text, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error sending Telegram message:', error.message);
    // Add specific handling for common errors like chat ID not found
    if (error.message.includes('chat not found')) {
      console.error('Make sure the BOT_TOKEN and CHAT_ID are correct and the bot has been started in the target chat.');
    }
  }
}

/**
 * Sends an email notification.
 * @param {string} subject - The email subject.
 * @param {string} text - The email body.
 */
async function sendEmailNotification(subject, text) {
  if (!enableEmail || !transporter) {
    console.log(
      "Email notifications are not enabled or transporter not initialized."
    );
    return;
  }
  console.log(`📧 Sending email: "${subject}"`);
  try {
    await transporter.sendMail({
      from: CONFIG.EMAIL_SENDER,
      to: CONFIG.EMAIL_RECIPIENT,
      subject: subject,
      text: text,
    });
    console.log("Email sent successfully.");
  } catch (error) {
    console.error(`❌ Failed to send email: ${error.message}`);
  }
}

/**
 * Sends a Pushbullet notification.
 * @param {string} title - The notification title.
 * @param {string} body - The notification body.
 */
async function sendPushNotification(title, body) {
  if (!enablePushbullet) {
    console.log("Pushbullet notifications are not enabled.");
    return;
  }
  console.log(`📱 Sending Pushbullet notification: "${title}"`);
  try {
    await axios.post(
      `${CONFIG.PUSHBULLET_API_BASE_URL}/pushes`,
      {
        type: "note",
        title: title,
        body: body,
      },
      {
        headers: {
          "Access-Token": CONFIG.PUSHBULLET_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 10000, // Add a timeout for the API call
      }
    );
    console.log("Pushbullet notification sent successfully.");
  } catch (error) {
    console.error(
      `❌ Failed to send Pushbullet notification: ${error.message}`
    );
    if (error.response) {
      console.error(
        `Pushbullet API responded with status ${error.response.status
        }: ${JSON.stringify(error.response.data)}`
      );
    } else if (error.request) {
      console.error("No response received from Pushbullet API.");
    }
  }
}


/**
 * Parses the appointment date from the HTML response
 */
function parseAppointmentDate(dateString) {
  // Example: "9/25/2025 9:00:00 AM"
  return moment.tz(dateString, 'M/D/YYYY h:mm:ss A', CONFIG.TIMEZONE);
}

/**
 * Extracts available appointments from HTML
 */
function extractAppointments(html) {
  const appointments = [];
  // Updated regex to be more robust and capture the full date string used in the label 'for' attribute
  const dateTimeRegex = /<label for="scheduler_([^"]+)">\s*([^<]+?)\s*<\/label>/g;


  let match;
  while ((match = dateTimeRegex.exec(html)) !== null) {
    const [_, fullDateAttribute, timeText] = match;
    // The fullDateAttribute contains the date string like "9/25/2025 9:00:00 AM"
    appointments.push({
      fullDate: parseAppointmentDate(fullDateAttribute),
      time: timeText.trim(), // The time text inside the label
      originalString: fullDateAttribute // Keep the original attribute string
    });
  }

  return appointments;
}

/**
 * Checks for available appointments
 */
async function checkAppointments() {
  if (state.isRunning) {
    console.log('Check already in progress');
    return false; // Indicate that check was skipped
  }

  // Ensure we have a current appointment set before proceeding
  if (!state.currentAppointment) {
    console.log('No appointment set. Skipping check.');
    // Do not send message here to avoid spamming on every check if no appointment is set
    return false; // Indicate that check was skipped
  }

  state.isRunning = true;
  console.log('\n--- Starting appointment check ---');
  console.log(`Comparing against current set appointment: ${state.currentAppointment.fullDate.format('YYYY-MM-DD HH:mm')} (Timezone: ${CONFIG.TIMEZONE})`);


  try {
    let response;
    // Create an AbortController for the request timeout
    const controller = new AbortController();
    // Set a timeout for the entire request process
    const requestTimeout = setTimeout(() => {
      controller.abort();
      console.error('Request explicitly timed out after 30 seconds via AbortController.');
    }, 30000); // 30 seconds timeout

    try {
      console.log('Sending request to appointment system...');

      // Add a unique user agent and generate a fresh session ID to avoid conflicts
      const headers = {
        ...CONFIG.HEADERS,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      };

      // Generate a fresh session ID to avoid conflicts
      const sessionId = 's' + Math.random().toString(36).substring(2, 15) + Date.now(); // Add timestamp for more uniqueness
      headers['Cookie'] = `AspxAutoDetectCookieSupport=1; ASP.NET_SessionId=${sessionId}`;

      response = await axios.post(
        'https://appointment.bmeia.gv.at/',
        new URLSearchParams({
          fromSpecificInfo: 'True',
          Language: 'en',
          Office: CONFIG.EMBASSY_OFFICE,
          CalendarId: CONFIG.CALENDAR_ID,
          PersonCount: CONFIG.PERSON_COUNT,
          Command: 'Next' // Keep 'Next' to see the next available month
        }),
        {
          headers: headers, // Use the dynamically generated headers
          signal: controller.signal, // Link the AbortController signal
          timeout: 30000, // Increased timeout to 30 seconds
          maxRedirects: 0,
          validateStatus: null, // Don't throw on non-2xx status codes
          httpsAgent: new HttpsAgent({
            keepAlive: true,
            // rejectUnauthorized: false // Only use if absolutely necessary and you understand the risks
          })
        }
      );

      clearTimeout(requestTimeout); // Clear the manual timeout if request completes

      console.log(`Response status: ${response.status} ${response.statusText}`);

      // Check for specific non-success status codes if needed
      if (response.status >= 400) {
        console.error(`Server returned error status ${response.status}`);
        // You might want to throw an error here or handle specific statuses
        // For now, we'll proceed and see if extractAppointments finds anything
      }


      if (!response.data) {
        throw new Error('Empty response from server');
      }

    } catch (error) {
      clearTimeout(requestTimeout); // Ensure timeout is cleared on error
      let errorMessage = 'Error making request: ';

      if (axios.isCancel(error)) {
        errorMessage = 'Request cancelled due to timeout or abort signal.';
        console.error(errorMessage);
        throw new Error(errorMessage); // Re-throw the specific error type
      } else if (error.code === 'ECONNREFUSED') {
        errorMessage += 'Connection refused - the server might be down';
      } else if (error.response) {
        errorMessage += `Server responded with status ${error.response.status}: ${error.response.statusText}`;
        console.error('Response headers:', error.response.headers);
        if (error.response.data && typeof error.response.data === 'string' && error.response.data.length < 1000) {
          console.error('Response data:', error.response.data);
        } else if (error.response.data) {
          console.error('Response data (truncated or non-string):', String(error.response.data).substring(0, 500) + '...');
        }
      } else if (error.request) {
        errorMessage += 'No response received from server';
        console.error('Request made but no response received');
      } else {
        // Something happened in setting up the request
        errorMessage += error.message;
      }

      console.error(errorMessage);
      throw new Error(errorMessage); // Re-throw the consolidated error
    }

    const appointments = extractAppointments(response.data);

    if (appointments.length === 0) {
      console.log('No appointments found in the response HTML.');
      // No need to notify if no appointments are found at all on the page
      return false; // Indicate no earlier appointment was found
    }

    // Sort appointments by date (earliest first)
    appointments.sort((a, b) => a.fullDate.valueOf() - b.fullDate.valueOf()); // Use valueOf() for reliable comparison
    const earliestFoundAppointment = appointments[0];
    console.log(`Earliest appointment found on website: ${earliestFoundAppointment.fullDate.format('YYYY-MM-DD HH:mm')} (Timezone: ${CONFIG.TIMEZONE})`);

    // Check if the found appointment is earlier than the currently set appointment
    // Use startOf('day') for comparison to ignore time component unless time is explicitly set by user
    const userSetDate = state.currentAppointment.fullDate.clone().startOf('day');
    const foundDate = earliestFoundAppointment.fullDate.clone().startOf('day');


    if (foundDate.isBefore(userSetDate)) {
      const message = `✅ *Found earlier appointment!*\n` +
        `📅 *Date:* ${earliestFoundAppointment.fullDate.format('dddd, MMMM Do, YYYY')}\n` +
        `🕒 *Time:* ${earliestFoundAppointment.time}\n` +
        `🔗 [Book Now](https://appointment.bmeia.gv.at/)`;

      console.log('Earlier appointment found. Sending notifications...');
      // Send notifications
      await sendMessage(message); // Telegram
      await sendEmailNotification("Earlier Appointment Found!", message); // Email
      await sendPushNotification("Earlier Appointment Found!", `New appointment available on ${earliestFoundAppointment.fullDate.format('YYYY-MM-DD')} at ${earliestFoundAppointment.time}`); // Pushbullet

      // Log the earlier appointment but DO NOT update state.currentAppointment or save to file
      console.log(`Found earlier appointment: ${earliestFoundAppointment.fullDate.format('YYYY-MM-DD')} (Your set appointment: ${state.currentAppointment.fullDate.format('YYYY-MM-DD')})`);
      return true; // Indicate an earlier appointment was found and notified

    } else {
      // --- MODIFICATION START ---
      const userApptDateStr = state.currentAppointment.fullDate.format('YYYY-MM-DD');
      const earliestAvailableDateStr = earliestFoundAppointment.fullDate.format('dddd, MMMM Do, YYYY');
      const earliestAvailableTimeStr = earliestFoundAppointment.time;

      const notificationMessage = `ℹ️ No appointments found earlier than your set date of *${userApptDateStr}*.\n\n` +
        `The earliest appointment currently available on the website is on *${earliestAvailableDateStr}* at *${earliestAvailableTimeStr}*.`;

      await sendMessage(notificationMessage);
      console.log(`No earlier appointments found than your set appointment (${userApptDateStr}). Notified user.`);
      // --- MODIFICATION END ---
      return false; // Indicate no earlier appointment was found
    }

  } catch (error) {
    console.error('Error in checkAppointments:', error);
    // Notify about the error
    if (state.botInitialized && state.bot && CONFIG.CHAT_ID) {
      try {
        await state.bot.sendMessage(CONFIG.CHAT_ID,
          '❌ An error occurred while checking for appointments. Please check the logs for details.'
        );
      } catch (botError) {
        console.error('Failed to send error notification:', botError);
      }
    }
    return false; // Indicate check failed
  } finally {
    state.isRunning = false;
    console.log('--- Appointment check finished ---');
  }
}

// --- Bot Setup ---
async function setupBot() {
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 10000; // 10 seconds between retries

  async function initializeBot(retryCount = 0) {
    // Use a global mutex to prevent multiple initialization attempts
    if (state.isBotInitializing) {
      console.log('Bot initialization already in progress. Skipping.');
      return state.bot; // Return current bot instance if available
    }

    state.isBotInitializing = true;
    console.log(`🤖 Initializing Telegram bot (attempt ${retryCount + 1}/${MAX_RETRIES})...`);

    try {
      // Create a new bot instance with a timeout
      const bot = new TelegramBot(CONFIG.BOT_TOKEN, {
        polling: true,
        request: {
          timeout: 30000, // 30 second timeout for requests
          agentClass: HttpsAgent,
          agentOptions: {
            keepAlive: true,
            keepAliveMsecs: 60000
          }
        }
      });

      // Set bot instance in state
      state.bot = bot;

      // Set up error handling for the bot
      bot.on('polling_error', (error) => {
        console.error('Polling error:', error.message);
        // Handle common polling errors
        if (error.code === 'EFATAL' || error.code === 'ETELEGRAM' || error.message.includes('getaddrinfo')) {
          console.error('Fatal polling error, will attempt to reconnect...');
          // Schedule a reconnection attempt
          setTimeout(() => reconnectBot(), RETRY_DELAY_MS);
        }
      });

      // Test the connection by getting the bot's info
      await bot.getMe();

      state.botInitialized = true;
      console.log('✅ Bot initialized successfully');
      return bot;

    } catch (error) {
      state.isBotInitialized = false; // Should be state.botInitialized
      console.error(`❌ Bot initialization attempt ${retryCount + 1} failed:`, error.message);

      // Clean up any partial initialization
      if (state.bot) {
        try {
          await state.bot.stopPolling();
        } catch (e) {
          console.error('Error stopping bot polling:', e);
        }
        state.bot = null;
      }

      state.isBotInitializing = false; // Clear the flag before retrying

      // If we have retries left, schedule a retry
      if (retryCount < MAX_RETRIES - 1) {
        console.log(`Retrying in ${RETRY_DELAY_MS / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        return initializeBot(retryCount + 1); // Recursive call, ensure state.isBotInitializing is false
      }

      console.error('❌ Max retries reached. Giving up on bot initialization.');
      return null;
    }
  }

  // Function to handle bot reconnection
  async function reconnectBot() {
    console.log('Attempting to reconnect bot...');
    try {
      if (state.bot) {
        try {
          await state.bot.stopPolling();
        } catch (e) {
          console.error('Error stopping bot during reconnect:', e);
        }
        state.bot = null;
      }

      state.botInitialized = false;
      state.isBotInitializing = false; // Reset this flag before re-initializing

      // Re-initialize the bot
      const newBotInstance = await initializeBot(); // Call initializeBot without retryCount, it will start from 0

      if (newBotInstance) {
        state.bot = newBotInstance; // Assign the newly initialized bot
        console.log('✅ Bot reconnected successfully');
        // Re-attach command handlers if needed by calling the setup function again for handlers
        setupCommandHandlers(state.bot);
      } else {
        console.error('❌ Bot reconnection failed after multiple retries.');
      }
    } catch (error) {
      console.error('Failed to reconnect bot:', error);
    }
  }

  // Function to set up command handlers (modified to be callable multiple times if needed)
  let commandHandlersAttached = false; // Prevent attaching multiple times if logic allows
  function setupCommandHandlers(bot) {
    if (!bot || commandHandlersAttached) { // Check if already attached
      // console.log('Command handlers already attached or bot not available.');
      return;
    }

    // Command to set the current appointment
    bot.onText(/\/set (.+)/, async (msg, match) => {
      if (String(msg.chat.id) !== CONFIG.CHAT_ID) return;
      try {
        let dateString = match[1].trim();
        const date = moment.tz(dateString, ['DD/MM/YYYY', 'DD.MM.YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY', 'M/D/YYYY'], CONFIG.TIMEZONE);
        if (!date.isValid()) {
          await sendMessage('❌ Invalid date format. Please use one of these formats:\n' +
            '• DD/MM/YYYY (e.g., 12/06/2025)\n' +
            '• DD.MM.YYYY (e.g., 12.06.2025)\n' +
            '• YYYY-MM-DD (e.g., 2025-06-12)\n' +
            '• MM/DD/YYYY (e.g., 06/12/2025)\n' +
            '• M/D/YYYY (e.g., 6/12/2025)');
          return;
        }
        const appointment = {
          fullDate: date.startOf('day'),
          time: '23:59',
          originalString: dateString,
          setAt: new Date().toISOString(),
          timezone: CONFIG.TIMEZONE
        };
        state.currentAppointment = appointment;
        const saved = await saveAppointment(appointment);
        if (saved) {
          const formattedDate = date.format('dddd, MMMM Do, YYYY');
          await sendMessage(`✅ Your current appointment has been set to: ${formattedDate}\n` +
            `I'll notify you if I find any earlier appointments.`);
          await checkAppointments();
        } else {
          await sendMessage('❌ Failed to save your appointment. Please try again.');
        }
      } catch (error) {
        console.error('Error setting appointment:', error);
        await sendMessage('❌ Error setting appointment. Please try again.');
      }
    });

    // Command to check now
    // --- MODIFICATION START ---
    state.bot.onText(/\/check/, async (msg) => { // Regex changed to standard /check
      // --- MODIFICATION END ---
      if (String(msg.chat.id) !== CONFIG.CHAT_ID) return;
      try {
        if (!state.currentAppointment) {
          await sendMessage('⚠️ No appointment set. Use `/set YYYY-MM-DD` to set your current appointment.'); // Added space in example
          return;
        }
        // --- MODIFICATION START ---
        // REMOVED: const currentDate = state.currentAppointment.fullDate.format('dddd, MMMM Do,YYYY');
        // REMOVED: await sendMessage(`🔍 Checking for appointments earlier than ${currentDate}...`);
        // --- MODIFICATION END ---
        await sendMessage('🔍 Initiating manual appointment check...'); // Optional: notify that check is starting
        await checkAppointments();
      } catch (error) {
        console.error('Error during manual check:', error);
        await sendMessage('❌ Error checking for appointments. Check logs for details.');
      }
    });

    // Command to show current appointment
    bot.onText(/\/current/, async (msg) => {
      if (String(msg.chat.id) !== CONFIG.CHAT_ID) return;
      try {
        if (state.currentAppointment) {
          const appt = state.currentAppointment;
          const formattedDate = appt.fullDate.format('dddd, MMMM Do, YYYY');
          const timezone = appt.timezone || CONFIG.TIMEZONE;
          const savedAt = appt.setAt ? new Date(appt.setAt).toLocaleString() : (appt.savedAt ? new Date(appt.savedAt).toLocaleString() : 'Unknown');
          let message = `📅 *Your Current Appointment*\n` +
            `*Date:* ${formattedDate}\n` +
            `*Time (for comparison baseline):* ${appt.time || 'End of day'}\n` +
            `*Timezone:* ${timezone}\n` +
            `*Set/Saved on:* ${savedAt}`;
          await sendMessage(message);
        } else {
          await sendMessage('⚠️ No appointment set.\n\n' +
            'Use `/set YYYY-MM-DD` to set your current appointment.\n' +
            'Example: `/set 2025-07-15`\n\n' +
            'I will notify you if I find any earlier appointments.');
        }
      } catch (error) {
        console.error('Error showing current appointment:', error);
        await sendMessage('❌ Error retrieving appointment details. Check logs for details.');
      }
    });

    // Command to show help/start message
    bot.onText(/\/start/, (msg) => {
      if (String(msg.chat.id) !== CONFIG.CHAT_ID) return;
      let helpMessage = `🤖 *Austrian Embassy Appointment Watcher*\n\n` +
        `*Commands:*\n` +
        `/set <date> - Set your current appointment date (e.g., /set 2025-12-31, /set 31/12/2025)\n` + // Updated example
        `/check - Check for appointments immediately\n` +
        `/current - Show your current appointment date\n` +
        `/start - Show this help message\n\n` +
        `I'll notify you via Telegram`;
      if (enableEmail) helpMessage += `, Email`;
      if (enablePushbullet) helpMessage += `, and Pushbullet`;
      helpMessage += ` if I find an earlier appointment!`;
      if (!enableEmail || !enablePushbullet) {
        helpMessage += `\n\n*Note:* Check .env for full Email/Pushbullet setup.`;
      }
      state.bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'Markdown' });
    });

    commandHandlersAttached = true; // Mark as attached
    console.log('✅ Telegram command handlers attached.');
  }

  try {
    // Initialize the bot and assign it to state.bot
    const botInstance = await initializeBot(); // initializeBot will handle retries internally

    // --- Bot Command Handlers ---
    // ONLY attach handlers if the bot was successfully initialized
    if (botInstance) {
      state.bot = botInstance; // Ensure state.bot is the successfully initialized instance
      setupCommandHandlers(state.bot); // Setup handlers using the confirmed bot instance
    } else {
      console.error('❌ Bot initialization failed after retries. Command handlers were not attached.');
      // The main function will catch this and exit if botInstance is null
    }

    console.log('🤖 Bot setup complete (or failed if botInstance is null).');
    return state.bot; // Return the bot instance (or null if failed)
  } catch (error) {
    console.error('Error setting up bot:', error);
    throw error; // Re-throw to be handled by the caller
  }
}

// --- Main Execution ---
async function main() {
  let checkJob = null;
  // Handle process termination
  const cleanup = async () => {
    if (state.isCleaningUp) return;
    state.isCleaningUp = true;
    console.log('\n🛑 Shutting down gracefully...');
    try {
      if (checkJob) {
        console.log('Stopping scheduled checks...');
        checkJob.stop();
        checkJob = null;
      }
      if (state.bot) {
        console.log('Stopping bot...');
        try {
          await state.bot.stopPolling({ cancel: true }); // Pass cancel: true for faster shutdown
          await new Promise(resolve => setTimeout(resolve, 2000)); // Shorter delay
          console.log('Bot polling stopped successfully');
        } catch (botError) {
          console.error('Error stopping bot polling:', botError.message);
        } finally {
          state.bot = null;
          state.botInitialized = false;
          state.isBotInitializing = false;
        }
      }
      console.log('✅ Cleanup complete. Goodbye!');
      process.exit(0);
    } catch (error) {
      console.error('Error during cleanup:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('uncaughtException', async (error) => {
    console.error('Uncaught Exception:', error);
    if (state.botInitialized && state.bot && CONFIG.CHAT_ID) {
      try {
        await state.bot.sendMessage(CONFIG.CHAT_ID, `❌ Uncaught Exception: ${error.message}\nShutting down.`);
      } catch (botError) {
        console.error('Failed to send uncaught exception notification:', botError.message);
      }
    }
    await cleanup(); // Ensure cleanup is called
  });
  process.on('unhandledRejection', async (reason, promise) => { // Made async for await cleanup
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (state.botInitialized && state.bot && CONFIG.CHAT_ID) {
      try {
        const reasonString = typeof reason === 'string' ? reason : (reason instanceof Error ? reason.message : JSON.stringify(reason));
        await state.bot.sendMessage(CONFIG.CHAT_ID, `❌ Unhandled Rejection: ${reasonString}\nBot may become unstable.`);
      } catch (botError) {
        console.error('Failed to send unhandled rejection notification:', botError.message);
      }
    }
    // Decide if unhandled rejections should always cause a full cleanup and exit
    // For stability, it might be better not to exit on every unhandled rejection, but log and notify.
    // await cleanup(); // Uncomment if you want to exit on unhandled rejections
  });


  try {
    console.log('🚀 Starting Austrian Embassy Appointment Watcher...');
    console.log(`📅 Timezone: ${CONFIG.TIMEZONE}`);
    // Initialize appointment persistence first
    await initializeAppointment();

    // Setup the bot
    const botInstance = await setupBot();

    if (!botInstance) {
      console.error('❌ Fatal error: Bot initialization failed. Exiting.');
      process.exit(1);
    }

    // Schedule the checks ONLY if the bot was successfully initialized
    console.log(`⏰ Scheduling checks with cron schedule: "${CONFIG.CHECK_INTERVAL}"`);
    checkJob = cron.schedule(CONFIG.CHECK_INTERVAL, async () => {
      console.log('\n⏰ Scheduled check running...');
      try {
        await checkAppointments();
      } catch (error) {
        console.error('Error in scheduled check:', error);
        if (state.botInitialized && state.bot && CONFIG.CHAT_ID) {
          try {
            await state.bot.sendMessage(CONFIG.CHAT_ID, `❌ Error in scheduled check: ${error.message}`);
          } catch (botError) {
            console.error('Failed to send error notification via bot:', botError.message);
          }
        }
      }
    }, {
      scheduled: true,
      timezone: CONFIG.TIMEZONE
    });

    // Initial check on startup
    console.log('\n🔍 Running initial check...');
    try {
      if (state.currentAppointment) {
        await checkAppointments();
        console.log('✅ Initial check complete. Bot is monitoring for earlier appointments...');
      } else {
        console.log('ℹ️ No appointment set on startup. Skipping initial check.');
        if (state.botInitialized && state.bot && CONFIG.CHAT_ID) {
          await sendMessage('⚠️ No appointment set. Use `/set <date>` to set your current appointment.\nExample: `/set 2025-07-15`');
        }
      }

      if (state.botInitialized && state.bot && CONFIG.CHAT_ID) {
        try {
          const cronParts = CONFIG.CHECK_INTERVAL.split(' ');
          let nextCheckMessage = `⏰ Next check: Scheduled according to "${CONFIG.CHECK_INTERVAL}"`;
          if (cronParts.length === 5 && cronParts[0].startsWith('*/')) {
            const minutes = parseInt(cronParts[0].substring(2), 10);
            if (!isNaN(minutes)) {
              const now = moment().tz(CONFIG.TIMEZONE);
              const currentMinute = now.minute();
              const minutesToAdd = (minutes - (currentMinute % minutes) + minutes) % minutes; // Corrected logic for next run
              const nextRun = now.clone().add(minutesToAdd, 'minutes').startOf('minute');
              if (minutesToAdd === 0 && currentMinute !== 0) { // If it's on the minute, but not 0th minute of an interval
                nextRun.add(minutes, 'minutes');
              } else if (minutesToAdd === 0 && currentMinute === 0 && now.second() > 0) { // If it's 0th minute of interval but cron already fired
                nextRun.add(minutes, 'minutes');
              }
              nextCheckMessage = `⏰ Next auto-check around: ${nextRun.format('YYYY-MM-DD HH:mm:ss')} (${CONFIG.TIMEZONE})`;
            }
          }
          let message = '🤖 Austrian Embassy Appointment Watcher is now running!\n' +
            `${nextCheckMessage}\n` +
            `🌍 Timezone: ${CONFIG.TIMEZONE}`;
          await state.bot.sendMessage(CONFIG.CHAT_ID, message);
        } catch (error) {
          console.error('Failed to send startup notification:', error.message);
        }
      }
    } catch (error) {
      console.error('Initial check failed:', error.message);
    }

  } catch (error) {
    console.error('Fatal error during setup:', error.message);
    if (state.botInitialized && state.bot && CONFIG.CHAT_ID) {
      try {
        await state.bot.sendMessage(CONFIG.CHAT_ID,
          `❌ Fatal error during bot setup:\n${error.message}\n\nCheck logs for details.`
        );
      } catch (botError) {
        console.error('Failed to send error notification via bot:', botError.message);
      }
    }
    process.exit(1);
  }
}

// Start the application
main();
