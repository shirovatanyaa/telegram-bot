const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
require('dotenv').config();

// Логирование
function log(message) {
  const timestamp = new Date().toLocaleString('ru-RU');
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
}

// Проверка переменных окружения
const requiredEnvVars = [
  'TELEGRAM_BOT_TOKEN',
  'GOOGLE_SHEETS_ID', 
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_PRIVATE_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    log(`❌ Ошибка: Переменная окружения ${envVar} не определена`);
    process.exit(1);
  }
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { 
  polling: true,
  onlyFirstMatch: true
});

// Настройка Google Sheets API
const auth = new google.auth.JWT(
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);

const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

// Хранение состояния пользователей
const userStates = new Map();

// Типы отчетов
const REPORT_TYPES = {
  MAIN: 'main',
  TRIAL: 'trial'
};

// Вопросы для основного отчета
const MAIN_QUESTIONS = [
  { id: 'tutor', text: '📝 Ваше имя (репетитор, только буквы):' },
  { id: 'date', text: '📅 Дата проведения занятий в формате ДД.ММ.ГГГГ (например, 25.12.2023):' },
  { id: 'chat', text: '💬 Номер чата:' },
  { id: 'parent', text: '👨‍👩‍👧‍👦 Имя родителя (только буквы):' },
  { id: 'student', text: '🎓 Имя ученика (только буквы):' },
  { id: 'amount', text: '💰 Сумма за занятие (в рублях, только цифры без пробелов и запятых):' }
];

// Вопросы для пробного периода
const TRIAL_QUESTIONS = [
  { id: 'tutor', text: '📝 Ваше имя (репетитор, только буквы):' },
  { id: 'parent', text: '👨‍👩‍👧‍👦 Имя родителя (только буквы):' },
  { id: 'student', text: '🎓 Имя ученика (только буквы):' },
  { id: 'amount_commission', text: '💰 Сумма за занятие и комиссия профи в формате "сумма/комиссия" (например: 1500/500):' }
];

// Функция для расчета выплаты (70% от суммы)
function calculatePayment(amount) {
  const numericAmount = parseInt(amount);
  if (isNaN(numericAmount)) return 0;
  return Math.round(numericAmount * 0.7);
}

// Валидация имени (только буквы и пробелы)
function validateName(name) {
  const nameRegex = /^[a-zA-Zа-яА-ЯёЁ\s]+$/;
  return nameRegex.test(name);
}

// Валидация суммы и комиссии
function validateAmountCommission(input) {
  // Убираем возможные пробелы
  const cleanedInput = input.replace(/\s/g, '');
  
  // Проверяем формат: цифры/цифры
  const regex = /^\d+\/\d+$/;
  if (!regex.test(cleanedInput)) return false;
  
  // Разделяем и проверяем числа
  const [amount, commission] = cleanedInput.split('/').map(Number);
  
  // Проверяем что это числа и amount > 0, commission >= 0
  return !isNaN(amount) && !isNaN(commission) && amount > 0 && commission >= 0;
}

// Запись данных в основной отчет (на первый лист)
async function writeToMainSheet(userData, userId, username) {
  try {
    const payment = calculatePayment(userData.amount);
    
    let userIdentifier = username || `user_${userId}`;
    if (!userIdentifier.startsWith('@') && userIdentifier !== `user_${userId}`) {
      userIdentifier = '@' + userIdentifier;
    }

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'A:H', // Просто колонки на первом листе
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          userIdentifier,
          userData.tutor,
          userData.date,
          userData.chat,
          userData.parent,
          userData.student,
          userData.amount,
          payment
        ]]
      }
    });

    log(`✅ Данные записаны: ${userData.student}`);
    return true;

  } catch (error) {
    log('Ошибка записи:' + error.message);
    return false;
  }
}

// Запись данных в пробный период (на первый лист)
async function writeToTrialSheet(userData, userId, username) {
  try {
    const [amount, commission] = userData.amount_commission.split('/').map(Number);
    const balance = amount - commission;
    
    let userIdentifier = username || `user_${userId}`;
    if (!userIdentifier.startsWith('@') && userIdentifier !== `user_${userId}`) {
      userIdentifier = '@' + userIdentifier;
    }

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'A:F', // Просто колонки на первом листе
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          userIdentifier,
          userData.tutor,
          userData.parent,
          userData.student,
          userData.amount_commission,
          balance
        ]]
      }
    });

    log(`✅ Данные пробного периода записаны: ${userData.student}`);
    return true;

  } catch (error) {
    log('Ошибка записи пробного периода:' + error.message);
    return false;
  }
}

// Функция для отправки следующего вопроса
function sendNextQuestion(chatId) {
  const userState = userStates.get(chatId);
  const questions = userState.reportType === REPORT_TYPES.MAIN ? MAIN_QUESTIONS : TRIAL_QUESTIONS;
  
  if (userState.currentQuestion < questions.length) {
    const question = questions[userState.currentQuestion];
    bot.sendMessage(chatId, question.text);
  } else {
    saveUserData(chatId);
  }
}

// Функция для сохранения данных
async function saveUserData(chatId) {
  const userState = userStates.get(chatId);
  
  if (userState) {
    const user = userState.user;
    let success = false;

    if (userState.reportType === REPORT_TYPES.MAIN) {
      success = await writeToMainSheet(userState.answers, user.id, user.username || user.first_name);
    } else {
      success = await writeToTrialSheet(userState.answers, user.id, user.username || user.first_name);
    }
    
    if (success) {
      let summaryMessage = `✅ Все данные успешно сохранены!\n\n📊 Сводка:\n`;
      
      if (userState.reportType === REPORT_TYPES.MAIN) {
        summaryMessage += `• Репетитор: ${userState.answers.tutor}\n`;
        summaryMessage += `• Дата: ${userState.answers.date}\n`;
        summaryMessage += `• Чат: ${userState.answers.chat}\n`;
        summaryMessage += `• Родитель: ${userState.answers.parent}\n`;
        summaryMessage += `• Ученик: ${userState.answers.student}\n`;
        summaryMessage += `• Сумма: ${userState.answers.amount} руб.`;
      } else {
        summaryMessage += `• Репетитор: ${userState.answers.tutor}\n`;
        summaryMessage += `• Родитель: ${userState.answers.parent}\n`;
        summaryMessage += `• Ученик: ${userState.answers.student}\n`;
        summaryMessage += `• Сумма/Комиссия: ${userState.answers.amount_commission}`;
      }
      
      summaryMessage += `\n\nДля нового заполнения отправьте /start`;
      
      bot.sendMessage(chatId, summaryMessage);
    } else {
      bot.sendMessage(chatId, '❌ Произошла ошибка при сохранении данных. Попробуйте снова: /start');
    }
    
    userStates.delete(chatId);
  }
}

// Обработчик команды /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from;
  
  const options = {
    reply_markup: {
      keyboard: [
        [{ text: '📊 Основной отчет' }],
        [{ text: '🆓 Пробный период' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
  
  const welcomeMessage = '👋 Добро пожаловать! Выберите тип отчета:\n\n📊 *Основной отчет* - полная отчетность по занятиям\n🆓 *Пробный период* - учет пробных занятий с комиссией';
  
  bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown', ...options });
});

// Обработчик кнопок
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  if (text === '📊 Основной отчет') {
    startMainReport(chatId, msg.from);
  } else if (text === '🆓 Пробный период') {
    startTrialReport(chatId, msg.from);
  }
});

// Запуск основного отчета
function startMainReport(chatId, user) {
  userStates.set(chatId, {
    currentQuestion: 0,
    user: user,
    reportType: REPORT_TYPES.MAIN,
    answers: {
      tutor: '',
      date: '',
      chat: '',
      parent: '',
      student: '',
      amount: ''
    }
  });
  
  bot.sendMessage(chatId, '📊 Выбран *Основной отчет*\n\nНачинаем заполнение:', { parse_mode: 'Markdown' })
    .then(() => {
      sendNextQuestion(chatId);
    });
}

// Запуск пробного периода
function startTrialReport(chatId, user) {
  userStates.set(chatId, {
    currentQuestion: 0,
    user: user,
    reportType: REPORT_TYPES.TRIAL,
    answers: {
      tutor: '',
      parent: '',
      student: '',
      amount_commission: ''
    }
  });
  
  bot.sendMessage(chatId, '🆓 Выбран *Пробный период*\n\nНачинаем заполнение:', { parse_mode: 'Markdown' })
    .then(() => {
      sendNextQuestion(chatId);
    });
}

// Обработчик текстовых сообщений
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  // Пропускаем кнопки и команды
  if (!text || text.startsWith('/') || text === '📊 Основной отчет' || text === '🆓 Пробный период') {
    return;
  }
  
  const userState = userStates.get(chatId);
  
  if (!userState) {
    bot.sendMessage(chatId, 'Для начала заполнения выберите тип отчета: /start');
    return;
  }
  
  const questions = userState.reportType === REPORT_TYPES.MAIN ? MAIN_QUESTIONS : TRIAL_QUESTIONS;
  const currentQuestionIndex = userState.currentQuestion;
  const currentQuestion = questions[currentQuestionIndex];
  
  let isValid = true;
  let errorMessage = '';
  
  switch (currentQuestion.id) {
    case 'tutor':
    case 'parent':
    case 'student':
      if (!validateName(text)) {
        isValid = false;
        errorMessage = '❌ Неверный формат! Можно вводить только буквы и пробелы.';
      }
      break;
      
    case 'date':
      const dateRegex = /^\d{2}\.\d{2}\.\d{4}$/;
      if (!dateRegex.test(text)) {
        isValid = false;
        errorMessage = '❌ Неверный формат даты. Используйте ДД.ММ.ГГГГ (например, 25.12.2023)';
      }
      break;
      
    case 'amount':
      const numbersOnly = /^\d+$/;
      if (!numbersOnly.test(text)) {
        isValid = false;
        errorMessage = '❌ Неверный формат суммы! Введите только цифры без пробелов, запятых и текста.\n\nПример: 1500';
      } else {
        const amount = parseInt(text);
        if (isNaN(amount) || amount <= 0) {
          isValid = false;
          errorMessage = '❌ Сумма должна быть положительным числом';
        }
      }
      break;
      
    case 'amount_commission':
      // Убираем пробелы из ввода
      const cleanedInput = text.replace(/\s/g, '');
      
      if (!validateAmountCommission(cleanedInput)) {
        isValid = false;
        errorMessage = '❌ Неверный формат! Используйте формат "сумма/комиссия" (например: 1500/500)\n\n• Только цифры и слэш\n• Без пробелов\n• Комиссия не может быть отрицательной';
      } else {
        // Сохраняем очищенный ввод
        userState.answers[currentQuestion.id] = cleanedInput;
      }
      break;
      
    default:
      userState.answers[currentQuestion.id] = text;
      break;
  }
  
  if (!isValid) {
    bot.sendMessage(chatId, errorMessage);
    return;
  }
  
  // Для всех полей кроме amount_commission сохраняем оригинальный текст
  if (currentQuestion.id !== 'amount_commission') {
    userState.answers[currentQuestion.id] = text;
  }
  
  userState.currentQuestion++;
  
  if (userState.currentQuestion < questions.length) {
    bot.sendMessage(chatId, '✅ Принято! Следующий вопрос:')
      .then(() => {
        sendNextQuestion(chatId);
      });
  } else {
    bot.sendMessage(chatId, '✅ Последний ответ принят! Сохраняю данные...');
    saveUserData(chatId);
  }
});

// Обработчик команды /cancel
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  
  if (userStates.has(chatId)) {
    userStates.delete(chatId);
    bot.sendMessage(chatId, '❌ Заполнение отменено. Для начала нового заполнения отправьте /start');
  } else {
    bot.sendMessage(chatId, 'Активных заполнений нет. Для начала отправьте /start');
  }
});

// Обработчик ошибок
bot.on('polling_error', (error) => {
  log('Polling error:' + error.message);
});

// Автоматический перезапуск при ошибках
process.on('uncaughtException', (error) => {
  log('⚠️ Необработанная ошибка: ' + error.message);
  setTimeout(() => {
    log('🔄 Перезапуск бота...');
    process.exit(1);
  }, 3000);
});

process.on('unhandledRejection', (reason, promise) => {
  log('⚠️ Необработанный промис: ' + reason);
  setTimeout(() => {
    log('🔄 Перезапуск бота...');
    process.exit(1);
  }, 3000);
});

log('🤖 Бот запущен и готов к работе...');