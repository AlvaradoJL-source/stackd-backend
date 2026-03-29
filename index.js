const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const configuration = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(configuration);

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const mapCategory = (primary) => {
  const map = {
    'FOOD_AND_DRINK': '🍔 Food & Dining',
    'GROCERIES': '🛒 Groceries',
    'TRANSPORTATION': '🚗 Transport',
    'TRAVEL': '✈️ Travel',
    'RENT_AND_UTILITIES': '🔌 Utilities',
    'MEDICAL': '💊 Healthcare',
    'ENTERTAINMENT': '🎬 Entertainment',
    'SHOPPING': '🛍️ Shopping',
    'PERSONAL_CARE': '💇 Personal Care',
    'EDUCATION': '🎓 Education',
    'GENERAL_MERCHANDISE': '🛍️ Shopping',
    'HOME_IMPROVEMENT': '🔧 Home Repairs',
    'TRANSFER_OUT': '💰 Savings Transfer',
    'TRANSFER_IN': '💵 Income',
    'INCOME': '💵 Income',
    'LOAN_PAYMENTS': '💳 Debt Payment',
  };
  return map[primary] || '❓ Other';
};

app.post('/api/connect_and_get', async (req, res) => {
  try {
    const tokenResponse = await plaidClient.sandboxPublicTokenCreate({
      institution_id: 'ins_109508',
      initial_products: ['transactions'],
    });
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: tokenResponse.data.public_token,
    });
    const accessToken = exchangeResponse.data.access_token;

    await wait(5000);

    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const startDate = ninetyDaysAgo.toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    let allTransactions = [];
    let attempts = 0;

    while (allTransactions.length === 0 && attempts < 3) {
      try {
        const response = await plaidClient.transactionsGet({
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
          options: { count: 100, offset: 0 },
        });
        allTransactions = response.data.transactions;
        if (allTransactions.length === 0) {
          attempts++;
          await wait(3000);
        }
      } catch (e) {
        attempts++;
        await wait(3000);
      }
    }

    const rows = allTransactions.map(t => ({
      description: t.merchant_name || t.name || 'Unknown',
      amount: Math.abs(t.amount),
      category: mapCategory(t.personal_finance_category?.primary || 'Other'),
      type: t.amount > 0 ? 'expense' : 'income',
      date: t.date,
    }));

    res.json({ success: true, transactions: rows });
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.error_message || error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'Stackd backend is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stackd backend running on port ${PORT}`);
});
