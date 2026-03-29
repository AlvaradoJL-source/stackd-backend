const express = require('express');
const cors = require('cors');
const https = require('https');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const httpsRequest = (url, options, body) => {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ ok: false, status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
};

const supabaseInsert = async (table, rows) => {
  const result = await httpsRequest(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=representation',
    },
  }, JSON.stringify(rows));
  if (!result.ok) {
    throw new Error(JSON.stringify(result.data));
  }
  return result.data;
};

const supabaseSelect = async (table, limit) => {
  const result = await httpsRequest(`${SUPABASE_URL}/rest/v1/${table}?limit=${limit}`, {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  return result;
};

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

app.post('/api/connect_and_sync', async (req, res) => {
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

    if (allTransactions.length === 0) {
      return res.json({ success: true, imported: 0, message: 'Connected but transactions not ready yet. Try again.' });
    }

    const rows = allTransactions.map(t => ({
      description: t.merchant_name || t.name || 'Unknown',
      amount: Math.abs(t.amount),
      category: mapCategory(t.personal_finance_category?.primary || 'Other'),
      type: t.amount > 0 ? 'expense' : 'income',
      date: t.date,
    }));

    const inserted = await supabaseInsert('transactions', rows);
    res.json({ success: true, imported: inserted.length });
  } catch (error) {
    console.error('Connect and sync error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.error_message || error.message });
  }
});

app.get('/api/debug', async (req, res) => {
  try {
    const result = await supabaseSelect('transactions', 1);
    res.json({ supabase_ok: result.ok, status: result.status, rows: Array.isArray(result.data) ? result.data.length : 0 });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'Stackd backend is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stackd backend running on port ${PORT}`);
});
