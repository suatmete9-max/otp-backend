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
const ADMIN_MARGIN = 1.5;

const db = new sqlite3.Database('./otp_database.db', (err) => {
    if (err) console.error('Database error', err);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, balance REAL DEFAULT 0.0, last_bonus_date TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_email TEXT, service TEXT, phone TEXT, status TEXT, code TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, type TEXT, amount REAL, details TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

app.post('/api/signup', (req, res) => {
    const { email, password } = req.body;
    db.run(`INSERT INTO users (email, password, balance, last_bonus_date) VALUES (?, ?, 0.0, '')`, [email, password], function(err) {
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

app.get('/api/user-balance', (req, res) => {
    const { email } = req.query;
    db.get(`SELECT balance FROM users WHERE email = ?`, [email], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "User not found" });
        res.json({ balance: row.balance });
    });
});

// ADMIN: View all deposits
app.get('/api/admin/deposits', (req, res) => {
    db.all(`SELECT * FROM transactions WHERE type = 'CRYPTO DEPOSIT' ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to fetch deposits" });
        res.json(rows);
    });
});

// ADMIN: Add balance directly to user
app.get('/api/admin/add-balance', (req, res) => {
    const { email, amount } = req.query;
    if(!email || !amount) return res.status(400).json({ error: "Email and amount required" });

    db.run(`UPDATE users SET balance = balance + ? WHERE email = ?`, [parseFloat(amount), email], function(err) {
        if(err) return res.status(500).json({ error: "Failed to update balance" });
        db.run(`INSERT INTO transactions (user_email, type, amount, details) VALUES (?, ?, ?, ?)`, [email, 'ADMIN FUND ADD', parseFloat(amount), 'Manually added by Admin']);
        res.json({ success: true, message: `Successfully added $${amount} to ${email}` });
    });
});

app.post('/api/claim-bonus', (req, res) => {
    const { email } = req.body;
    const today = new Date().toISOString().slice(0, 10);

    db.get(`SELECT last_bonus_date, balance FROM users WHERE email = ?`, [email], (err, user) => {
        if (err || !user) return res.status(400).json({ error: "User not found" });
        if (user.last_bonus_date === today) {
            return res.status(400).json({ error: "You have already claimed your daily bonus today!" });
        }

        db.run(`UPDATE users SET balance = balance + 0.01, last_bonus_date = ? WHERE email = ?`, [today, email], function(err) {
            db.run(`INSERT INTO transactions (user_email, type, amount, details) VALUES (?, ?, ?, ?)`, [email, 'DAILY BONUS', 0.01, 'Claimed Daily Login Bonus']);
            db.get(`SELECT balance FROM users WHERE email = ?`, [email], (err, updatedUser) => {
                res.json({ success: true, balance: updatedUser.balance, message: "Successfully claimed $0.01 Daily Bonus!" });
            });
        });
    });
});

app.post('/api/deposit', (req, res) => {
    const { email, amount, txId } = req.body;
    if(!email || !amount || !txId) return res.status(400).json({ error: "All fields required" });

    db.run(`INSERT INTO transactions (user_email, type, amount, details) VALUES (?, ?, ?, ?)`, [email, 'CRYPTO DEPOSIT', amount, `TxID: ${txId} (Pending Verification)`], function(err) {
        if(err) return res.status(500).json({ error: "Failed to submit deposit" });
        res.json({ success: true, message: "Deposit submitted successfully!" });
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
                return res.status(400).json({ error: "Insufficient wallet balance!" });
            }

            try {
                const response = await axios.get(`${BASE_URL}/user/buy/activation/${country}/${cheapestOperator}/${service}`, { headers });
                const orderId = response.data.id.toString();
                const phone = response.data.phone;

                db.run(`UPDATE users SET balance = balance - ? WHERE email = ?`, [finalPrice, email]);
                db.run(`INSERT INTO orders (id, user_email, service, phone, status, code) VALUES (?, ?, ?, ?, ?, ?)`, [orderId, email, service, phone, 'WAITING', '-']);
                db.run(`INSERT INTO transactions (user_email, type, amount, details) VALUES (?, ?, ?, ?)`, [email, 'NUMBER PURCHASE', finalPrice, `Service: ${service} (${phone})`]);

                res.json({ id: orderId, phone });
            } catch (buyErr) {
                res.status(500).json({ error: "Number out of stock" });
            }
        });
    } catch (error) { res.status(500).json({ error: "Process failed" }); }
});

app.get('/api/history', (req, res) => {
    const { email } = req.query;
    db.all(`SELECT type as category, amount as cost, details as info, created_at FROM transactions WHERE user_email = ? 
            UNION ALL 
            SELECT 'NUMBER ORDER' as category, 0 as cost, 'Service: ' || service || ' | Phone: ' || phone || ' | Status: ' || status as info, created_at FROM orders WHERE user_email = ? 
            ORDER BY created_at DESC`, [email, email], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed" });
        res.json(rows);
    });
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
    } catch (error) { res.status(500).json({ error: "Cancel failed" }); }
});

app.listen(3000, () => console.log('Server running on port 3000'));
