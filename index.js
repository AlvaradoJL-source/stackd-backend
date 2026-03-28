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

let ACCESS_TOKEN = null;

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
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startDate = thirtyDaysAgo.toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    const response = await plaidClient.transactionsGet({
      access_token: ACCESS_TOKEN,
      start_date: startDate,
      end_date: endDate,
    });
    res.json(response.data);
  } catch (error) {
    console.error('Transactions error:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
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
