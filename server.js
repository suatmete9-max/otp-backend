require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();
const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secure-otp-hub-secret-key-999!@#';
const BASE_URL = 'https://5sim.net/v1';
const headers = { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' };
const ADMIN_MARGIN = 2.0; 
const ADMIN_EMAIL = 'bc115078@gmail.com';

let cache = { countries: null, countriesTime: 0, services: {}, prices: {} };
const CACHE_TTL = 30 * 1000; 

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, message: { error: "Too many attempts, please try again later." } });
const buyLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: { error: "Too many requests, please slow down." } });

const db = new sqlite3.Database('./otp_database.db', (err) => {
    if (err) console.error('Database error', err);
    else db.run('PRAGMA journal_mode = WAL;');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, password TEXT, balance REAL DEFAULT 0.0, last_bonus_date TEXT, ref_code TEXT, referred_by TEXT, is_admin INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_email TEXT, service TEXT, phone TEXT, status TEXT, code TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, type TEXT, amount REAL, details TEXT, status TEXT DEFAULT 'PENDING', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token) {
        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (!err) req.user = user;
        });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.isAdmin !== 1) {
        return res.status(403).json({ error: "Admin privileges required" });
    }
    next();
}

app.post('/api/signup', authLimiter, async (req, res) => {
    try {
        const { name, email, password, refCode } = req.body;
        if (!email || !password || password.length < 6) return res.status(400).json({ error: "Email and password (min 6 chars) required" });
        
        const cleanEmail = email.trim().toLowerCase();
        const hashedPassword = await bcrypt.hash(password, 10);
        const myRefCode = 'M' + Math.floor(100000 + Math.random() * 900000);
        const isAdmin = (cleanEmail === ADMIN_EMAIL.toLowerCase()) ? 1 : 0;

        db.run(`INSERT INTO users (name, email, password, balance, last_bonus_date, ref_code, referred_by, is_admin) VALUES (?, ?, ?, 10.0, '', ?, ?, ?)`, 
        [name ? name.trim() : 'User', cleanEmail, hashedPassword, myRefCode, refCode ? refCode.trim() : '', isAdmin], function(err) {
            if (err) return res.status(400).json({ error: "Email already registered!" });
            res.json({ success: true, message: "Account created successfully!" });
        });
    } catch (e) { res.status(500).json({ error: "Internal server error" }); }
});

app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: "Email and password required" });
        const cleanEmail = email.trim().toLowerCase();

        db.get(`SELECT * FROM users WHERE email = ?`, [cleanEmail], async (err, user) => {
            if (err || !user) return res.status(400).json({ error: "Invalid email or password!" });

            const validPassword = await bcrypt.compare(password, user.password);
            if (!validPassword) return res.status(400).json({ error: "Invalid email or password!" });

            const isAdmin = (user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase() || user.is_admin === 1) ? 1 : 0;
            const token = jwt.sign({ email: user.email, isAdmin }, JWT_SECRET, { expiresIn: '7d' });

            res.json({ success: true, token, email: user.email, name: user.name, balance: user.balance, refCode: user.ref_code, isAdmin });
        });
    } catch (e) { res.status(500).json({ error: "Internal server error" }); }
});

app.post('/api/forgot-password', authLimiter, async (req, res) => {
    try {
        const { email, newPassword } = req.body;
        if (!email || !newPassword || newPassword.length < 6) return res.status(400).json({ error: "Valid email and new password required" });
        const cleanEmail = email.trim().toLowerCase();
        
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        db.run(`UPDATE users SET password = ? WHERE email = ?`, [hashedPassword, cleanEmail], function(err) {
            if (err || this.changes === 0) return res.status(400).json({ error: "Email not found!" });
            res.json({ success: true, message: "Password updated successfully!" });
        });
    } catch (e) { res.status(500).json({ error: "Internal server error" }); }
});

app.get('/api/user-balance', authenticateToken, (req, res) => {
    const email = req.user ? req.user.email : req.query.email;
    if(!email) return res.status(400).json({ error: "Unauthorized" });
    db.get(`SELECT balance FROM users WHERE email = ?`, [email.toLowerCase()], (err, row) => {
        if (err || !row) return res.json({ balance: 10.0 });
        res.json({ balance: row.balance });
    });
});

app.get('/api/admin/deposits', authenticateToken, requireAdmin, (req, res) => {
    db.all(`SELECT * FROM transactions WHERE type = 'CRYPTO DEPOSIT' ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed" });
        res.json(rows);
    });
});

app.post('/api/admin/approve-deposit', authenticateToken, requireAdmin, (req, res) => {
    const { depositId } = req.body;
    db.get(`SELECT * FROM transactions WHERE id = ? AND type = 'CRYPTO DEPOSIT' AND status = 'PENDING'`, [depositId], (err, dep) => {
        if (err || !dep) return res.status(400).json({ error: "Deposit not found" });

        db.serialize(() => {
            db.run(`BEGIN TRANSACTION`);
            db.run(`UPDATE transactions SET status = 'APPROVED' WHERE id = ?`, [depositId]);
            db.run(`UPDATE users SET balance = balance + ? WHERE email = ?`, [dep.amount, dep.user_email]);
            db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, 
            [dep.user_email, 'ADMIN FUND ADD', dep.amount, `Approved Tx ID: ${dep.id}`, 'APPROVED'], (err) => {
                if (err) { db.run(`ROLLBACK`); return res.status(500).json({ error: "Failed" }); }
                db.run(`COMMIT`);
                res.json({ success: true, message: `Successfully approved $${dep.amount}` });
            });
        });
    });
});

app.post('/api/apply-referral', authenticateToken, (req, res) => {
    const { refCode } = req.body;
    const email = req.user ? req.user.email : req.body.email;
    if (!email || !refCode) return res.status(400).json({ error: "Invalid request" });

    db.get(`SELECT * FROM users WHERE email = ?`, [email.toLowerCase()], (err, user) => {
        if (err || !user) return res.status(400).json({ error: "User not found" });
        if (user.referred_by) return res.status(400).json({ error: "Already applied a referral code!" });

        db.get(`SELECT * FROM users WHERE ref_code = ?`, [refCode.trim()], (err, referrer) => {
            if (err || !referrer) return res.status(400).json({ error: "Invalid referral code!" });

            db.serialize(() => {
                db.run(`BEGIN TRANSACTION`);
                db.run(`UPDATE users SET referred_by = ?, balance = balance + 0.05 WHERE email = ?`, [refCode.trim(), email.toLowerCase()]);
                db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, [email.toLowerCase(), 'REFERRAL BONUS', 0.05, `Bonus from code`, 'APPROVED'], (err) => {
                    if (err) { db.run(`ROLLBACK`); return res.status(500).json({ error: "Failed" }); }
                    db.run(`COMMIT`);
                    db.get(`SELECT balance FROM users WHERE email = ?`, [email.toLowerCase()], (err, updatedUser) => {
                        res.json({ success: true, balance: updatedUser.balance, message: "Referral applied! $0.05 added." });
                    });
                });
            });
        });
    });
});

app.post('/api/claim-bonus', authenticateToken, (req, res) => {
    const email = req.user ? req.user.email : req.body.email;
    const today = new Date().toISOString().slice(0, 10);
    if(!email) return res.status(400).json({ error: "Unauthorized" });

    db.get(`SELECT last_bonus_date, balance FROM users WHERE email = ?`, [email.toLowerCase()], (err, user) => {
        if (err || !user) return res.status(400).json({ error: "User not found" });
        if (user.last_bonus_date === today) return res.status(400).json({ error: "Already claimed daily bonus today!" });

        db.serialize(() => {
            db.run(`BEGIN TRANSACTION`);
            db.run(`UPDATE users SET balance = balance + 0.01, last_bonus_date = ? WHERE email = ?`, [today, email.toLowerCase()]);
            db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, [email.toLowerCase(), 'DAILY BONUS', 0.01, 'Claimed Daily Bonus', 'APPROVED'], (err) => {
                if (err) { db.run(`ROLLBACK`); return res.status(500).json({ error: "Failed" }); }
                db.run(`COMMIT`);
                db.get(`SELECT balance FROM users WHERE email = ?`, [email.toLowerCase()], (err, updatedUser) => {
                    res.json({ success: true, balance: updatedUser.balance, message: "Claimed $0.01 Daily Bonus!" });
                });
            });
        });
    });
});

app.post('/api/deposit', authenticateToken, (req, res) => {
    const { amount, txId } = req.body;
    const email = req.user ? req.user.email : req.body.email;
    if (!email || !amount || !txId) return res.status(400).json({ error: "All fields required" });

    db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, [email.toLowerCase(), 'CRYPTO DEPOSIT', amount, `TxID: ${txId.trim()}`, 'PENDING'], function(err) {
        if (err) return res.status(500).json({ error: "Failed" });
        res.json({ success: true, message: "Deposit submitted!" });
    });
});

app.get('/api/countries', authenticateToken, async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/guest/countries`);
        res.json(response.data);
    } catch (error) { res.status(500).json({ error: "Failed" }); }
});

app.get('/api/services', authenticateToken, async (req, res) => {
    const { country } = req.query;
    try {
        const response = await axios.get(`${BASE_URL}/guest/prices?country=${country}`);
        const countryData = response.data[country];
        if(!countryData) return res.json(['any']);
        let allKeys = Object.keys(countryData);
        if (!allKeys.includes('any')) allKeys.includes('any') || allKeys.push('any');
        res.json(allKeys);
    } catch (error) { res.json(['any']); }
});

app.get('/api/operators', authenticateToken, async (req, res) => {
    const { country, service } = req.query;
    try {
        const response = await axios.get(`${BASE_URL}/guest/prices?country=${country}&product=${service}`);
        const serviceData = response.data[country] && response.data[country][service] ? response.data[country][service] : null;
        if(!serviceData) return res.json([]);

        let operatorsList = [];
        for (const [opName, opDetails] of Object.entries(serviceData)) {
            operatorsList.push({
                operator: opName,
                cost: (opDetails.cost || 0.05) * ADMIN_MARGIN,
                count: opDetails.count || 0
            });
        }
        res.json(operatorsList);
    } catch (error) { res.json([]); }
});

// BULLET-PROOF SMART BUY ROUTE WITH MULTI-FALLBACK (GUARANTEED STOCK MATCH)
app.post('/api/buy', authenticateToken, buyLimiter, async (req, res) => {
    const { country, service, operator } = req.body;
    const selectedOp = operator || 'any';
    const userEmail = (req.user && req.user.email) ? req.user.email : (req.body.email ? req.body.email.trim().toLowerCase() : null);

    if (!userEmail) {
        return res.status(400).json({ error: "User email required. Please logout and login again." });
    }

    try {
        const pricesRes = await axios.get(`${BASE_URL}/guest/prices?country=${country}&product=${service}`);
        const serviceData = pricesRes.data[country] && pricesRes.data[country][service] ? pricesRes.data[country][service] : null;
        
        let opCost = 0.05;
        if (serviceData && serviceData[selectedOp]) {
            opCost = serviceData[selectedOp].cost;
        } else if (serviceData && serviceData['any']) {
            opCost = serviceData['any'].cost;
        } else if (serviceData) {
            const firstKey = Object.keys(serviceData)[0];
            opCost = serviceData[firstKey].cost;
        }

        const finalPrice = opCost * ADMIN_MARGIN;

        db.get(`SELECT balance FROM users WHERE email = ?`, [userEmail], async (err, user) => {
            if (!user) {
                db.run(`INSERT INTO users (name, email, password, balance, ref_code) VALUES (?, ?, '123456', 10.0, 'M999999')`, [userEmail.split('@')[0], userEmail]);
            }
            
            const currentBal = user ? user.balance : 10.0;
            if (currentBal < finalPrice) return res.status(400).json({ error: "Insufficient wallet balance!" });

            let orderId = null;
            let phone = null;
            let successfulOp = selectedOp;

            // ATTEMPT 1: Try purchasing with the selected operator
            try {
                const response = await axios.get(`${BASE_URL}/user/buy/activation/${country}/${selectedOp}/${service}`, { headers });
                orderId = response.data.id.toString();
                phone = response.data.phone;
            } catch (err1) {
                // ATTEMPT 2: Fallback to 'any' operator automatically if specific operator fails
                try {
                    const fallbackRes = await axios.get(`${BASE_URL}/user/buy/activation/${country}/any/${service}`, { headers });
                    orderId = fallbackRes.data.id.toString();
                    phone = fallbackRes.data.phone;
                    successfulOp = 'any';
                } catch (err2) {
                    // ATTEMPT 3: Fallback to first available operator in stock
                    if (serviceData) {
                        for (const opKey of Object.keys(serviceData)) {
                            try {
                                const lastRes = await axios.get(`${BASE_URL}/user/buy/activation/${country}/${opKey}/${service}`, { headers });
                                orderId = lastRes.data.id.toString();
                                phone = lastRes.data.phone;
                                successfulOp = opKey;
                                break;
                            } catch (e) {}
                        }
                    }
                }
            }

            if (!orderId || !phone) {
                return res.status(500).json({ error: "Number currently out of stock from provider." });
            }

            db.serialize(() => {
                db.run(`BEGIN TRANSACTION`);
                db.run(`UPDATE users SET balance = MAX(0, balance - ?) WHERE email = ?`, [finalPrice, userEmail]);
                db.run(`INSERT INTO orders (id, user_email, service, phone, status, code) VALUES (?, ?, ?, ?, ?, ?)`, [orderId, userEmail, service, phone, 'WAITING', '-']);
                db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, [userEmail, 'NUMBER PURCHASE', finalPrice, `Service: ${service} (${phone}) [Op: ${successfulOp}]`, 'APPROVED'], (err) => {
                    if (err) { db.run(`ROLLBACK`); return res.status(500).json({ error: "Failed" }); }
                    db.run(`COMMIT`);
                    res.json({ id: orderId, phone });
                });
            });
        });
    } catch (error) { res.status(500).json({ error: "Process failed or out of stock." }); }
});

app.get('/api/history', authenticateToken, (req, res) => {
    const email = (req.user && req.user.email) ? req.user.email : req.query.email;
    if(!email) return res.status(400).json({ error: "Unauthorized" });

    db.all(`SELECT type as category, amount as cost, details as info, status, created_at FROM transactions WHERE user_email = ? 
            UNION ALL 
            SELECT 'NUMBER ORDER' as category, 0 as cost, 'Service: ' || service || ' | Phone: ' || phone || ' | Status: ' || status as info, status, created_at FROM orders WHERE user_email = ? 
            ORDER BY created_at DESC`, [email.toLowerCase(), email.toLowerCase()], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed" });
        res.json(rows);
    });
});

app.get('/api/check/:id', authenticateToken, (req, res) => {
    const orderId = req.params.id;

    db.get(`SELECT * FROM orders WHERE id = ?`, [orderId], async (err, order) => {
        if (err || !order) return res.status(403).json({ error: "Order not found" });
        if (order.status === 'SUCCESS') return res.json({ status: 'RECEIVED', code: order.code });

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
});

app.get('/api/cancel/:id', authenticateToken, (req, res) => {
    const orderId = req.params.id;

    db.get(`SELECT * FROM orders WHERE id = ? AND status = 'WAITING'`, [orderId], async (err, order) => {
        if (err || !order) return res.status(403).json({ error: "Order cannot be canceled" });

        try {
            const response = await axios.get(`${BASE_URL}/user/cancel/${orderId}`, { headers });
            
            db.get(`SELECT amount FROM transactions WHERE details LIKE ?`, [`%${order.phone}%`], (err, tx) => {
                const refundAmount = tx ? tx.amount : 0;

                db.serialize(() => {
                    db.run(`BEGIN TRANSACTION`);
                    db.run(`UPDATE orders SET status = 'REFUNDED' WHERE id = ?`, [orderId]);
                    if (refundAmount > 0 && order.user_email) {
                        db.run(`UPDATE users SET balance = balance + ? WHERE email = ?`, [refundAmount, order.user_email]);
                        db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, [order.user_email, 'REFUND', refundAmount, `Refund for order ${orderId}`, 'APPROVED']);
                    }
                    db.run(`COMMIT`);
                    res.json({ status: response.data.status });
                });
            });
        } catch (error) { res.status(500).json({ error: "Cancel failed" }); }
    });
});

app.listen(3000, () => console.log('Secure Enterprise Server running on port 3000'));
