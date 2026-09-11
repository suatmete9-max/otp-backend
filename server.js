require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const app = express();

app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY;
const BASE_URL = 'https://5sim.net/v1';
const headers = { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' };
const ADMIN_MARGIN = 1.5; // 50% Profit Margin

const db = new sqlite3.Database('./otp_database.db', (err) => {
    if (err) console.error('Database error', err);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, balance REAL DEFAULT 0.0)`);
    db.run(`CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_email TEXT, service TEXT, phone TEXT, status TEXT, code TEXT)`);
});

app.post('/api/signup', (req, res) => {
    const { email, password } = req.body;
    db.run(`INSERT INTO users (email, password, balance) VALUES (?, ?, 0.0)`, [email, password], function(err) {
        if (err) return res.status(400).json({ error: "Email already registered!" });
        res.json({ success: true, email, balance: 0.0 });
    });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ? AND password = ?`, [email, password], (err, row) => {
        if (err || !row) return res.status(400).json({ error: "Invalid email or password!" });
        res.json({ success: true, email: row.email, balance: row.balance });
    });
});

// User specific wallet balance
app.get('/api/user-balance', (req, res) => {
    const { email } = req.query;
    db.get(`SELECT balance FROM users WHERE email = ?`, [email], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "User not found" });
        res.json({ balance: row.balance });
    });
});

// Add funds to user wallet
app.post('/api/add-funds', (req, res) => {
    const { email, amount } = req.body;
    db.run(`UPDATE users SET balance = balance + ? WHERE email = ?`, [amount, email], function(err) {
        if (err) return res.status(400).json({ error: "Failed to add funds" });
        db.get(`SELECT balance FROM users WHERE email = ?`, [email], (err, row) => {
            res.json({ success: true, balance: row.balance });
        });
    });
});

app.get('/api/countries', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/guest/countries`);
        res.json(response.data);
    } catch (error) { res.status(500).json({ error: "Failed" }); }
});

app.get('/api/services', async (req, res) => {
    const { country } = req.query;
    try {
        const response = await axios.get(`${BASE_URL}/guest/prices?country=${country}`);
        const countryData = response.data[country];
        if(!countryData) return res.json([]);
        res.json(Object.keys(countryData));
    } catch (error) { res.status(500).json({ error: "Failed to fetch services" }); }
});

app.get('/api/price', async (req, res) => {
    const { country, service } = req.query;
    try {
        const response = await axios.get(`${BASE_URL}/guest/prices?country=${country}&product=${service}`);
        const priceData = response.data[country][service];
        let lowestPrice = Infinity;
        for (const opKey of Object.keys(priceData)) {
            if (priceData[opKey].cost < lowestPrice) lowestPrice = priceData[opKey].cost;
        }
        res.json({ price: lowestPrice * ADMIN_MARGIN });
    } catch (error) { res.status(500).json({ error: "Price check failed" }); }
});

app.post('/api/buy', async (req, res) => {
    const { country, service, email } = req.body;
    try {
        const pricesRes = await axios.get(`${BASE_URL}/guest/prices?country=${country}&product=${service}`);
        const priceData = pricesRes.data[country][service];
        
        let cheapestOperator = 'any';
        let lowestPrice = Infinity;
        for (const [opName, opDetails] of Object.entries(priceData)) {
            if (opDetails.cost < lowestPrice && opDetails.count > 0) {
                lowestPrice = opDetails.cost;
                cheapestOperator = opName;
            }
        }
        const finalPrice = lowestPrice * ADMIN_MARGIN;

        db.get(`SELECT balance FROM users WHERE email = ?`, [email], async (err, user) => {
            if (err || !user) return res.status(400).json({ error: "User not found" });
            if (user.balance < finalPrice) {
                return res.status(400).json({ error: "Insufficient wallet balance! Please add funds." });
            }

            try {
                const response = await axios.get(`${BASE_URL}/user/buy/activation/${country}/${cheapestOperator}/${service}`, { headers });
                const orderId = response.data.id.toString();
                const phone = response.data.phone;

                db.run(`UPDATE users SET balance = balance - ? WHERE email = ?`, [finalPrice, email]);
                db.run(`INSERT INTO orders (id, user_email, service, phone, status, code) VALUES (?, ?, ?, ?, ?, ?)`, [orderId, email, service, phone, 'WAITING', '-']);

                res.json({ id: orderId, phone });
            } catch (buyErr) {
                res.status(500).json({ error: "Number out of stock or buy failed" });
            }
        });
    } catch (error) { res.status(500).json({ error: "Process failed" }); }
});

app.get('/api/check/:id', async (req, res) => {
    const orderId = req.params.id;
    try {
        const response = await axios.get(`${BASE_URL}/user/check/${orderId}`, { headers });
        const sms = response.data.sms;
        if (sms && sms.length > 0) {
            const code = sms[0].code;
            db.run(`UPDATE orders SET status = 'SUCCESS', code = ? WHERE id = ?`, [code, orderId]);
            res.json({ status: 'RECEIVED', code });
        } else {
            res.json({ status: 'WAITING' });
        }
    } catch (error) { res.status(500).json({ error: "Check failed" }); }
});

app.get('/api/cancel/:id', async (req, res) => {
    const orderId = req.params.id;
    try {
        const response = await axios.get(`${BASE_URL}/user/cancel/${orderId}`, { headers });
        db.run(`UPDATE orders SET status = 'REFUNDED' WHERE id = ?`, [orderId]);
        res.json({ status: response.data.status });
    } catchGot it! You want to update your OTP panel (`otp-hub.vercel.app`) with three main changes:

1. **User Wallet Balance:** Fix the dashboard so that each logged-in user sees **their own deposited wallet balance** rather than the master provider/admin account balance (like the $1.345 shown in the top right).
2. **50% Profit Margin:** Apply an automatic pricing formula that adds a **50% markup** on top of the base provider prices so you earn 50% profit on every transaction.
3. **"Cheapest" Server & "Any Other" Service:** Create a special server option labeled **"Cheapest"** that includes all countries, and set the service name/category to **"Any Other"** while ensuring your 50% margin applies universally across all services and countries.

---

### 1. User Wallet Balance Logic
Instead of fetching the master 5sim API balance for the user, you need to fetch the user's wallet balance from your database (e.g., MongoDB/Supabase/Firebase) where their deposited funds are stored.

**Example Code (Frontend/Backend adjustment):**
```javascript
// Fetch user's actual wallet balance from your database after login
async function loadUserWallet(userId) {
    const response = await fetch(`/api/get-user-balance?userId=${userId}`);
    const data = await response.json();
    
    // Update the UI balance display
    document.getElementById('user-balance').innerText = `$${data.walletBalance.toFixed(3)}`;
}
