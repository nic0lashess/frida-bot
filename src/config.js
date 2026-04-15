require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}. Copy .env.example to .env and fill it.`);
  return v;
}

module.exports = {
  targetDate: required('TARGET_DATE'),
  tickets: parseInt(required('TICKETS'), 10),
  ticketType: process.env.TICKET_TYPE || 'general',
  buyer: {
    name: process.env.BUYER_NAME || '',
    lastName: process.env.BUYER_LAST_NAME || '',
    email: required('BUYER_EMAIL'),
    phone: process.env.BUYER_PHONE || '',
  },
  whatsappOwner: process.env.WHATSAPP_OWNER || '',
  whatsappEnabled: process.env.WHATSAPP_ENABLED !== 'false' && !!process.env.WHATSAPP_OWNER,
  telegramToken: process.env.TELEGRAM_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  checkCron: process.env.CHECK_CRON || '*/2 * * * *',
  slotProposalTimeoutMin: parseInt(process.env.SLOT_PROPOSAL_TIMEOUT_MIN || '10', 10),
  paymentLinkTimeoutMin: parseInt(process.env.PAYMENT_LINK_TIMEOUT_MIN || '15', 10),
  ticketUrl: process.env.TICKET_URL || 'https://boletos.museofridakahlo.org.mx/es/tickets/museo-frida-kahlo-cdmx',
  headed: process.env.HEADED === 'true',
  logLevel: process.env.LOG_LEVEL || 'info',
};
