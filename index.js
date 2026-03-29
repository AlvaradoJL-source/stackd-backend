const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

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

let ACCESS_TOKEN = null;

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

app.post('/api/create_link_token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'stackd-user-1' },
      client_name: 'Stackd',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    });
    res.json(response.data);
  } catch (error) {
    console.error('Link token error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sandbox_connect', async (req, res) => {
  try {
    const tokenResponse = await plaidClient.sandboxPublicTokenCreate({
      institution_id: 'ins_109508',
      initial_products: ['transactions'],
    });
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: tokenResponse.data.public_token,
    });
    ACCESS_TOKEN = exchangeResponse.data.access_token;
    res.json({ success: true, message: 'Sandbox bank connected!' });
  } catch (error) {
    console.error('Sandbox connect error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.post('/api/sync_to_supabase', async (req, res) => {
  try {
    if (!ACCESS_TOKEN) {
      return res.status(400).json({ error: 'No bank connected yet' });
    }

    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const startDate = ninetyDaysAgo.toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    let allTransactions = [];
    let hasMore = true;
    let offset = 0;

    while (hasMore) {
      const response = await plaidClient.transactionsGet({
        access_token: ACCESS_TOKEN,
        start_date: startDate,
        end_date: endDate,
        options: { count: 100, offset: offset },
      });
      allTransactions = allTransactions.concat(response.data.transactions);
      hasMore = allTransactions.length < response.data.total_transactions;
      offset = allTransactions.length;
    }

    const rows = allTransactions.map(t => ({
      description: t.merchant_name || t.name || 'Unknown',
      amount: Math.abs(t.amount),
      category: mapCategory(t.personal_finance_category?.primary || 'Other'),
      type: t.amount > 0 ? 'expense' : 'income',
      date: t.date,
    }));

    const { data, error } = await supabase.from('transactions').insert(rows).select();

    if (error) {
      console.error('Supabase insert error:', error);
      res.status(500).json({ error: error.message });
    } else {
      res.json({ success: true, imported: data.length });
    }
  } catch (error) {
    console.error('Sync error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/exchange_public_token', async (req, res) => {
  try {
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: req.body.public_token,
    });
    ACCESS_TOKEN = response.data.access_token;
    res.json({ success: true });
  } catch (error) {
    console.error('Exchange error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/transactions', async (req, res) => {
  try {
    if (!ACCESS_TOKEN) {
      return res.status(400).json({ error: 'No bank connected yet' });
    }
    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const startDate = ninetyDaysAgo.toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    let allTransactions = [];
    let hasMore = true;
    let offset = 0;

    while (hasMore) {
      const response = await plaidClient.transactionsGet({
        access_token: ACCESS_TOKEN,
        start_date: startDate,
        end_date: endDate,
        options: { count: 100, offset: offset },
      });
      allTransactions = allTransactions.concat(response.data.transactions);
      hasMore = allTransactions.length < response.data.total_transactions;
      offset = allTransactions.length;
    }

    res.json({ transactions: allTransactions, total: allTransactions.length });
  } catch (error) {
    console.error('Transactions error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.error_message || error.message });
  }
});

app.get('/api/balance', async (req, res) => {
  try {
    if (!ACCESS_TOKEN) {
      return res.status(400).json({ error: 'No bank connected yet' });
    }
    const response = await plaidClient.accountsBalanceGet({
      access_token: ACCESS_TOKEN,
    });
    res.json(response.data);
  } catch (error) {
    console.error('Balance error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'Stackd backend is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stackd backend running on port ${PORT}`);
});
