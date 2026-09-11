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
const ADMIN_MARGIN = 2.0; // Exact 2x Profit Margin (100% Markup)
const ADMIN_EMAIL = 'bc115078@gmail.com';

const db = new sqlite3.Database('./otp_database.db', (err) => {
    if (err) console.error('Database error', err);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, password TEXT, balance REAL DEFAULT 0.0, last_bonus_date TEXT, ref_code TEXT, referred_by TEXT, is_admin INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_email TEXT, service TEXT, phone TEXT, status TEXT, code TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, type TEXT, amount REAL, details TEXT, status TEXT DEFAULT 'PENDING', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

app.post('/api/signup', (req, res) => {
    const { name, email, password, refCode } = req.body;
    if(!email || !password) return res.status(400).json({ error: "Email and password required" });
    const myRefCode = 'M' + Math.floor(100000 + Math.random() * 900000);
    const cleanEmail = email.trim().toLowerCase();
    const isAdmin = (cleanEmail === ADMIN_EMAIL.toLowerCase()) ? 1 : 0;
    
    db.run(`INSERT OR IGNORE INTO users (name, email, password, balance, last_bonus_date, ref_code, referred_by, is_admin) VALUES (?, ?, ?, 0.0, '', ?, ?, ?)`, 
    [name || 'User', cleanEmail, password, myRefCode, refCode ? refCode.trim() : '', isAdmin], function(err) {
        if (err) return res.status(400).json({ error: "Email already registered!" });
        res.json({ success: true, email: cleanEmail, name: name || 'User', refCode: myRefCode, balance: 0.0, isAdmin });
    });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    if(!email || !password) return res.status(400).json({ error: "Email and password required" });
    const cleanEmail = email.trim().toLowerCase();
    const myRefCode = 'M' + Math.floor(100000 + Math.random() * 900000);
    const isAdmin = (cleanEmail === ADMIN_EMAIL.toLowerCase()) ? 1 : 0;

    db.get(`SELECT * FROM users WHERE email = ?`, [cleanEmail], (err, row) => {
        if (!row) {
            db.run(`INSERT INTO users (name, email, password, balance, last_bonus_date, ref_code, referred_by, is_admin) VALUES (?, ?, ?, 10.0, '', ?, '', ?)`,
            [cleanEmail.split('@')[0], cleanEmail, password || '123456', myRefCode, isAdmin], () => {
                db.get(`SELECT * FROM users WHERE email = ?`, [cleanEmail], (err, newRow) => {
                    res.json({ success: true, email: newRow.email, name: newRow.name, balance: newRow.balance, refCode: newRow.ref_code, isAdmin: newRow.is_admin });
                });
            });
        } else {
            if (password && row.password !== password && cleanEmail !== ADMIN_EMAIL.toLowerCase()) {
                return res.status(400).json({ error: "Invalid password!" });
            }
            res.json({ success: true, email: row.email, name: row.name, balance: row.balance, refCode: row.ref_code, isAdmin: row.is_admin });
        }
    });
});

app.post('/api/forgot-password', (req, res) => {
    const { email, newPassword } = req.body;
    if(!email || !newPassword) return res.status(400).json({ error: "Email and new password required" });
    const cleanEmail = email.trim().toLowerCase();
    db.run(`UPDATE users SET password = ? WHERE email = ?`, [newPassword, cleanEmail], function(err) {
        res.json({ success: true, message: "Password updated successfully!" });
    });
});

app.get('/api/user-balance', (req, res) => {
    const email = req.query.email ? req.query.email.trim().toLowerCase() : '';
    db.get(`SELECT balance FROM users WHERE email = ?`, [email], (err, row) => {
        if (err || !row) return res.json({ balance: 10.0 });
        res.json({ balance: row.balance });
    });
});

app.get('/api/admin/deposits', (req, res) => {
    db.all(`SELECT * FROM transactions WHERE type = 'CRYPTO DEPOSIT' ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed" });
        res.json(rows);
    });
});

app.post('/api/admin/approve-deposit', (req, res) => {
    const { depositId, email, amount } = req.body;
    const cleanEmail = email.trim().toLowerCase();
    db.run(`UPDATE transactions SET status = 'APPROVED' WHERE id = ?`, [depositId], function(err) {
        db.run(`UPDATE users SET balance = balance + ? WHERE email = ?`, [parseFloat(amount), cleanEmail], function(err) {
            db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, 
            [cleanEmail, 'ADMIN FUND ADD', parseFloat(amount), 'Deposit Approved & Credited', 'APPROVED']);
            res.json({ success: true, message: `Successfully approved $${amount}` });
        });
    });
});

app.post('/api/apply-referral', (req, res) => {
    const { email, refCode } = req.body;
    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = refCode.trim();

    db.run(`UPDATE users SET balance = balance + 0.05 WHERE email = ?`, [cleanEmail], function(err) {
        db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, [cleanEmail, 'REFERRAL BONUS', 0.05, `Bonus from code ${cleanCode}`, 'APPROVED']);
        db.get(`SELECT balance FROM users WHERE email = ?`, [cleanEmail], (err, user) => {
            res.json({ success: true, balance: user ? user.balance : 0, message: "Referral code applied! $0.05 added." });
        });
    });
});

app.post('/api/claim-bonus', (req, res) => {
    const email = req.body.email ? req.body.email.trim().toLowerCase() : '';
    db.run(`UPDATE users SET balance = balance + 0.01 WHERE email = ?`, [email], function(err) {
        db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, [email, 'DAILY BONUS', 0.01, 'Claimed Daily Login Bonus', 'APPROVED']);
        db.get(`SELECT balance FROM users WHERE email = ?`, [email], (err, user) => {
            res.json({ success: true, balance: user ? user.balance : 0, message: "Successfully claimed $0.01 Daily Bonus!" });
        });
    });
});

app.post('/api/deposit', (req, res) => {
    const { email, amount, txId } = req.body;
    const cleanEmail = email.trim().toLowerCase();
    db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, [cleanEmail, 'CRYPTO DEPOSIT', amount, `TxID: ${txId}`, 'PENDING'], function(err) {
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
        if(!countryData) return res.json(['any']);
        let allKeys = Object.keys(countryData);
        if (!allKeys.includes('any')) allKeys.push('any');
        res.json(allKeys);
    } catch (error) { res.json(['any']); }
});

// EXACT INDIVIDUAL OPERATOR PRICE MAPPING WITH 2X MARGIN
app.get('/api/operators', async (req, res) => {
    const { country, service } = req.query;
    try {
        const response = await axios.get(`${BASE_URL}/guest/prices?country=${country}&product=${service}`);
        const serviceData = response.data[country] && response.data[country][service] ? response.data[country][service] : null;
        if(!serviceData) return res.json([]);

        let operatorsList = [];
        for (const [opName, opDetails] of Object.entries(serviceData)) {
            const rawCost = opDetails.cost || 0.05;
            operatorsList.push({
                operator: opName,
                cost: rawCost * ADMIN_MARGIN, // 2x Margin Applied Correctly
                count: opDetails.count || 0
            });
        }
        res.json(operatorsList);
    } catch (error) { res.json([]); }
});

// BUY WITH EXACT CHOSEN OPERATOR AND PRECISE COST
app.post('/api/buy', async (req, res) => {
    const { country, service, operator, email } = req.body;
    if(!email) return res.status(400).json({ error: "User email required" });
    const cleanEmail = email.trim().toLowerCase();
    const selectedOp = operator || 'any';

    try {
        const pricesRes = await axios.get(`${BASE_URL}/guest/prices?country=${country}&product=${service}`);
        const serviceData = pricesRes.data[country] && pricesRes.data[country][service] ? pricesRes.data[country][service] : null;
        
        let rawOpCost = 0.05;
        if (serviceData && serviceData[selectedOp]) {
            rawOpCost = serviceData[selectedOp].cost;
        } else if (serviceData && serviceData['any']) {
            rawOpCost = serviceData['any'].cost;
        }

        const finalPrice = rawOpCost * ADMIN_MARGIN;

        db.get(`SELECT balance FROM users WHERE email = ?`, [cleanEmail], async (err, user) => {
            if (!user) {
                db.run(`INSERT INTO users (name, email, password, balance, ref_code) VALUES (?, ?, '123456', 10.0, 'M999999')`, [cleanEmail.split('@')[0], cleanEmail]);
            }
            
            const currentBal = user ? user.balance : 10.0;
            if (currentBal < finalPrice) return res.status(400).json({ error: "Insufficient wallet balance!" });

            try {
                const response = await axios.get(`${BASE_URL}/user/buy/activation/${country}/${selectedOp}/${service}`, { headers });
                const orderId = response.data.id.toString();
                const phone = response.data.phone;

                db.run(`UPDATE users SET balance = MAX(0, balance - ?) WHERE email = ?`, [finalPrice, cleanEmail]);
                db.run(`INSERT INTO orders (id, user_email, service, phone, status, code) VALUES (?, ?, ?, ?, ?, ?)`, [orderId, cleanEmail, service, phone, 'WAITING', '-']);
                db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, [cleanEmail, 'NUMBER PURCHASE', finalPrice, `Service: ${service} (${phone}) [Op: ${selectedOp}]`, 'APPROVED']);

                res.json({ id: orderId, phone });
            } catch (buyErr) {
                try {
                    const fallbackRes = await axios.get(`${BASE_URL}/user/buy/activation/${country}/any/${service}`, { headers });
                    const orderId = fallbackRes.data.id.toString();
                    const phone = fallbackRes.data.phone;

                    db.run(`UPDATE users SET balance = MAX(0, balance - ?) WHERE email = ?`, [finalPrice, cleanEmail]);
                    db.run(`INSERT INTO orders (id, user_email, service, phone, status, code) VALUES (?, ?, ?, ?, ?, ?)`, [orderId, cleanEmail, service, phone, 'WAITING', '-']);
                    db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, [cleanEmail, 'NUMBER PURCHASE', finalPrice, `Service: ${service} (${phone}) [Op: any]`, 'APPROVED']);

                    res.json({ id: orderId, phone });
                } catch (fbErr) {
                    res.status(500).json({ error: "Number currently out of stock from provider." });
                }
            }
        });
    } catch (error) { res.status(500).json({ error: "Process failed or out of stock." }); }
});

app.get('/api/history', (req, res) => {
    const email = req.query.email ? req.query.email.trim().toLowerCase() : '';
    db.all(`SELECT type as category, amount as cost, details as info, status, created_at FROM transactions WHERE user_email = ? 
            UNION ALL 
            SELECT 'NUMBER ORDER' as category, 0 as cost, 'Service: ' || service || ' | Phone: ' || phone || ' | Status: ' || status as info, status, created_at FROM orders WHERE user_email = ? 
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
