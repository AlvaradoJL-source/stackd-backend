const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
require('dotenv').config();

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());

const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';

const configuration = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(configuration);

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// One persistent Plaid Item (the connected bank account).
// Priority: Railway env vars -> in-memory cache -> create a fresh sandbox Item.
// ---------------------------------------------------------------------------
const cache = { accessToken: null, itemId: null, source: null };

const clearCache = () => {
  cache.accessToken = null;
  cache.itemId = null;
  cache.source = null;
};

const getItem = async ({ fresh } = {}) => {
  if (!fresh && process.env.PLAID_ACCESS_TOKEN) {
    return {
      accessToken: process.env.PLAID_ACCESS_TOKEN,
      itemId: process.env.PLAID_ITEM_ID || null,
      source: 'env',
    };
  }

  if (!fresh && cache.accessToken) {
    return { accessToken: cache.accessToken, itemId: cache.itemId, source: 'memory' };
  }

  if (PLAID_ENV !== 'sandbox') {
    const err = new Error('Bank connection required (Plaid Link not set up yet)');
    err.code = 'LINK_REQUIRED';
    throw err;
  }

  const tokenResponse = await plaidClient.sandboxPublicTokenCreate({
    institution_id: 'ins_109508',
    initial_products: ['transactions'],
  });
  const exchangeResponse = await plaidClient.itemPublicTokenExchange({
    public_token: tokenResponse.data.public_token,
  });

  cache.accessToken = exchangeResponse.data.access_token;
  cache.itemId = exchangeResponse.data.item_id || null;
  cache.source = 'memory';

  console.log(`SANDBOX_ACCESS_TOKEN=${cache.accessToken} SANDBOX_ITEM_ID=${cache.itemId}  <- paste both into Railway Variables as PLAID_ACCESS_TOKEN / PLAID_ITEM_ID to keep this connection across restarts`);

  return { accessToken: cache.accessToken, itemId: cache.itemId, source: 'memory', created: true };
};

// ---------------------------------------------------------------------------
// Category mapping: Plaid personal_finance_category -> Stackd category string.
// ---------------------------------------------------------------------------
const mapCategory = (primary, detailed) => {
  const p = primary || '';
  const d = detailed || '';

  switch (p) {
    case 'FOOD_AND_DRINK':
      if (d === 'FOOD_AND_DRINK_GROCERIES') return '🛒 Groceries';
      if (d === 'FOOD_AND_DRINK_COFFEE') return '☕ Coffee';
      if (d === 'FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR') return '🍺 Bars & Nightlife';
      return '🍔 Food & Dining';
    case 'GENERAL_MERCHANDISE':
      if (d === 'GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES') return '👕 Clothing';
      if (d === 'GENERAL_MERCHANDISE_PET_SUPPLIES') return '🐾 Pet Care';
      if (d === 'GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES') return '🎁 Gifts';
      return '🛍️ Shopping';
    case 'TRANSPORTATION':
      if (d === 'TRANSPORTATION_GAS') return '⛽ Gas';
      return '🚗 Transport';
    case 'TRAVEL':
      return '✈️ Travel';
    case 'RENT_AND_UTILITIES':
      if (d === 'RENT_AND_UTILITIES_RENT') return '🏠 Housing';
      return '🔌 Utilities';
    case 'MEDICAL':
      return '💊 Healthcare';
    case 'ENTERTAINMENT':
      return '🎬 Entertainment';
    case 'PERSONAL_CARE':
      if (d === 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS') return '💪 Fitness';
      return '💇 Personal Care';
    case 'HOME_IMPROVEMENT':
      return '🔧 Home Repairs';
    case 'GENERAL_SERVICES':
      if (d === 'GENERAL_SERVICES_EDUCATION') return '🎓 Education';
      return '🧾 Services';
    case 'GOVERNMENT_AND_NON_PROFIT':
      return '🏛️ Government & Donations';
    case 'BANK_FEES':
      return '🏦 Bank Fees';
    case 'LOAN_PAYMENTS':
      return '💳 Debt Payment';
    case 'INCOME':
      return '💵 Income';
    case 'TRANSFER_OUT':
    case 'TRANSFER_IN':
      return '💰 Savings Transfer';
    default:
      return '❓ Other';
  }
};

const kindOf = (t) => {
  const primary = t.personal_finance_category?.primary || '';
  if (primary === 'INCOME') return 'income';
  if (primary === 'TRANSFER_IN' || primary === 'TRANSFER_OUT') return 'transfer';
  if (primary === 'LOAN_PAYMENTS') return 'payment';
  return (Number(t.amount) || 0) < 0 ? 'refund' : 'expense';
};

const toRow = (t, itemId) => {
  const primary = t.personal_finance_category?.primary || null;
  const detailed = t.personal_finance_category?.detailed || null;
  const amount = Number(t.amount) || 0;
  return {
    description: t.merchant_name || t.name || 'Unknown',
    amount: Math.abs(amount),
    category: mapCategory(primary, detailed),
    type: amount < 0 ? 'income' : 'expense',
    date: t.date || null,
    plaid_transaction_id: t.transaction_id || null,
    plaid_pending_transaction_id: t.pending_transaction_id || null,
    plaid_account_id: t.account_id || null,
    plaid_item_id: itemId || null,
    merchant_name: t.merchant_name || null,
    pending: !!t.pending,
    pfc_primary: primary,
    pfc_detailed: detailed,
    kind: kindOf(t),
  };
};

// ---------------------------------------------------------------------------
// Plaid fetch helpers.
// ---------------------------------------------------------------------------
const plaidErrorCode = (e) => e?.response?.data?.error_code || null;

const localYMD = (dateObj) => {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

// Pull every transaction in the window, 500 at a time, max 20 pages.
const fetchAllTransactions = async (accessToken, startDate, endDate) => {
  const all = [];
  let offset = 0;
  let total = null;
  let pages = 0;

  while (pages < 20) {
    const response = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: 500, offset },
    });
    const batch = response.data.transactions || [];
    total = response.data.total_transactions || 0;
    all.push(...batch);
    pages++;
    offset += batch.length;
    if (batch.length === 0 || all.length >= total) break;
  }

  return all;
};

const ITEM_RESET_CODES = ['INVALID_ACCESS_TOKEN', 'ITEM_NOT_FOUND', 'ITEM_LOGIN_REQUIRED'];

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.post('/api/connect_and_get', async (req, res) => {
  try {
    const fresh = req.body?.fresh === true;
    let item = await getItem({ fresh });
    if (item.created) await wait(5000);

    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const startDate = localYMD(ninetyDaysAgo);
    const endDate = localYMD(now);

    let allTransactions = [];
    let attempts = 0;
    let itemReset = false;
    let lastError = null;

    while (attempts < 3) {
      try {
        allTransactions = await fetchAllTransactions(item.accessToken, startDate, endDate);
        lastError = null;
        if (allTransactions.length > 0) break;
        attempts++;
        if (attempts < 3) await wait(3000);
      } catch (e) {
        lastError = e;
        const code = plaidErrorCode(e);
        if (ITEM_RESET_CODES.includes(code) && !itemReset) {
          // The stored Item is dead. Build a new one once and try again.
          itemReset = true;
          clearCache();
          item = await getItem({ fresh: true });
          await wait(5000);
          continue;
        }
        if (code === 'PRODUCT_NOT_READY') {
          attempts++;
          if (attempts < 3) await wait(3000);
          continue;
        }
        throw e;
      }
    }

    if (allTransactions.length === 0 && lastError) throw lastError;

    const rows = allTransactions.map(t => toRow(t, item.itemId));

    res.json({
      success: true,
      env: PLAID_ENV,
      item_id: item.itemId,
      fetched_at: new Date().toISOString(),
      count: rows.length,
      transactions: rows,
    });
  } catch (error) {
    if (error.code === 'LINK_REQUIRED') {
      return res.status(400).json({ error: error.message });
    }
    const plaidMsg = error.response?.data?.error_message;
    console.error('connect_and_get error:', plaidErrorCode(error) || error.code || '', plaidMsg || error.message);
    res.status(500).json({ error: plaidMsg || error.message || 'Unexpected server error' });
  }
});

app.get('/api/status', (req, res) => {
  const tokenSource = process.env.PLAID_ACCESS_TOKEN ? 'env' : (cache.accessToken ? 'memory' : null);
  const itemId = process.env.PLAID_ACCESS_TOKEN
    ? (process.env.PLAID_ITEM_ID || null)
    : (cache.accessToken ? cache.itemId : null);
  res.json({
    env: PLAID_ENV,
    plaidConfigured: !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET),
    hasCachedItem: !!(process.env.PLAID_ACCESS_TOKEN || cache.accessToken),
    item_id: itemId,
    tokenSource,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

app.get('/', (req, res) => {
  res.json({ status: 'Stackd backend is running' });
});

// Final error handler: plain message only, never a stack trace.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  console.error('Unhandled error:', err.message);
  res.status(status).json({ error: err.message || 'Unexpected server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stackd backend running on port ${PORT}`);
});
