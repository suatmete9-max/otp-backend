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

// SECURITY HEADERS & CORS
app.use(helmet());
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secure-otp-hub-secret-key-999!@#';
const BASE_URL = 'https://5sim.net/v1';
const headers = { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' };
const ADMIN_MARGIN = 2.0; // 2x Profit Margin
const ADMIN_EMAIL = 'bc115078@gmail.com';

// RATE LIMITERS TO PREVENT BRUTE FORCE & ABUSE
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: "Too many attempts, please try again later." } });
const buyLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: "Too many purchase requests, please slow down." } });

// SQLITE WAL MODE & FOREIGN KEYS FOR STABILITY
const db = new sqlite3.Database('./otp_database.db', (err) => {
    if (err) console.error('Database error', err);
    else db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA foreign_keys = ON;');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        name TEXT, 
        email TEXT UNIQUE, 
        password TEXT, 
        balance REAL DEFAULT 0.0, 
        last_bonus_date TEXT, 
        ref_code TEXT, 
        referred_by TEXT, 
        is_admin INTEGER DEFAULT 0
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, 
        user_email TEXT, 
        service TEXT, 
        phone TEXT, 
        status TEXT, 
        code TEXT, 
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_email) REFERENCES users(email)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        user_email TEXT, 
        type TEXT, 
        amount REAL, 
        details TEXT, 
        status TEXT DEFAULT 'PENDING', 
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_email) REFERENCES users(email)
    )`);
});

// AUTHENTICATION MIDDLEWARE FOR SECURE ROUTES
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Access token required" });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid or expired token" });
        req.user = user;
        next();
    });
}

// ADMIN ROLE CHECK MIDDLEWARE
function requireAdmin(req, res, next) {
    if (!req.user || req.user.isAdmin !== 1) {
        return res.status(403).json({ error: "Admin privileges required" });
    }
    next();
}

// 1. SIGNUP (Bcrypt Hashing & Validation)
app.post('/api/signup', authLimiter, async (req, res) => {
    try {
        const { name, email, password, refCode } = req.body;
        if (!email || !password || password.length < 6) {
            return res.status(400).json({ error: "Email and password (min 6 chars) required" });
        }
        
        const cleanEmail = email.trim().toLowerCase();
        const hashedPassword = await bcrypt.hash(password, 10);
        const myRefCode = 'M' + Math.floor(100000 + Math.random() * 900000);
        const isAdmin = (cleanEmail === ADMIN_EMAIL.toLowerCase()) ? 1 : 0;

        db.run(`INSERT INTO users (name, email, password, balance, last_bonus_date, ref_code, referred_by, is_admin) VALUES (?, ?, ?, 0.0, '', ?, ?, ?)`, 
        [name ? name.trim() : 'User', cleanEmail, hashedPassword, myRefCode, refCode ? refCode.trim() : '', isAdmin], function(err) {
            if (err) return res.status(400).json({ error: "Email already registered!" });
            res.json({ success: true, message: "Account created successfully!" });
        });
    } catch (e) {
        res.status(500).json({ error: "Internal server error" });
    }
});

// 2. LOGIN (JWT Token Generation)
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
    } catch (e) {
        res.status(500).json({ error: "Internal server error" });
    }
});

// 3. FORGOT PASSWORD
app.post('/api/forgot-password', authLimiter, async (req, res) => {
    try {
        const { email, newPassword } = req.body;
        if (!email || !newPassword || newPassword.length < 6) return res.status(400).json({ error: "Valid email and new password (min 6 chars) required" });
        const cleanEmail = email.trim().toLowerCase();
        
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        db.run(`UPDATE users SET password = ? WHERE email = ?`, [hashedPassword, cleanEmail], function(err) {
            if (err || this.changes === 0) return res.status(400).json({ error: "Email not found!" });
            res.json({ success: true, message: "Password updated successfully!" });
        });
    } catch (e) {
        res.status(500).json({ error: "Internal server error" });
    }
});

// 4. GET AUTHENTICATED USER BALANCE
app.get('/api/user-balance', authenticateToken, (req, res) => {
    db.get(`SELECT balance FROM users WHERE email = ?`, [req.user.email], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "User not found" });
        res.json({ balance: row.balance });
    });
});

// 5. ADMIN: GET ALL PENDING DEPOSITS
app.get('/api/admin/deposits', authenticateToken, requireAdmin, (req, res) => {
    db.all(`SELECT * FROM transactions WHERE type = 'CRYPTO DEPOSIT' ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to fetch deposits" });
        res.json(rows);
    });
});

// 6. ADMIN: APPROVE DEPOSIT (DB Transaction Secure Amount)
app.post('/api/admin/approve-deposit', authenticateToken, requireAdmin, (req, res) => {
    const { depositId } = req.body;
    if (!depositId) return res.status(400).json({ error: "Deposit ID required" });

    db.get(`SELECT * FROM transactions WHERE id = ? AND type = 'CRYPTO DEPOSIT' AND status = 'PENDING'`, [depositId], (err, dep) => {
        if (err || !dep) return res.status(400).json({ error: "Deposit transaction not found or already processed" });

        db.serialize(() => {
            db.run(`BEGIN TRANSACTION`);
            db.run(`UPDATE transactions SET status = 'APPROVED' WHERE id = ?`, [depositId]);
            db.run(`UPDATE users SET balance = balance + ? WHERE email = ?`, [dep.amount, dep.user_email]);
            db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, 
            [dep.user_email, 'ADMIN FUND ADD', dep.amount, `Deposit Approved & Credited (Tx ID: ${dep.id})`, 'APPROVED'], (err) => {
                if (err) {
                    db.run(`ROLLBACK`);
                    return res.status(500).json({ error: "Failed to approve deposit" });
                }
                db.run(`COMMIT`);
                res.json({ success: true, message: `Successfully approved $${dep.amount} for ${dep.user_email}` });
            });
        });
    });
});

// 7. SECURE REFERRAL REDEMPTION (One-Time & Anti Self-Referral)
app.post('/api/apply-referral', authenticateToken, (req, res) => {
    const { refCode } = req.body;
    if (!refCode) return res.status(400).json({ error: "Referral code required" });
    const cleanCode = refCode.trim();

    db.get(`SELECT * FROM users WHERE email = ?`, [req.user.email], (err, user) => {
        if (err || !user) return res.status(400).json({ error: "User not found" });
        if (user.referred_by) return res.status(400).json({ error: "You have already applied a referral code!" });
        if (user.ref_code === cleanCode) return res.status(400).json({ error: "You cannot use your own referral code!" });

        db.get(`SELECT * FROM users WHERE ref_code = ?`, [cleanCode], (err, referrer) => {
            if (err || !referrer) return res.status(400).json({ error: "Invalid referral code!" });

            db.serialize(() => {
                db.run(`BEGIN TRANSACTION`);
                db.run(`UPDATE users SET referred_by = ?, balance = balance + 0.05 WHERE email = ?`, [cleanCode, req.user.email]);
                db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, [req.user.email, 'REFERRAL BONUS', 0.05, `Bonus from code ${cleanCode}`, 'APPROVED'], (err) => {
                    if (err) {
                        db.run(`ROLLBACK`);
                        return res.status(500).json({ error: "Failed to apply referral" });
                    }
                    db.run(`COMMIT`);
                    db.get(`SELECT balance FROM users WHERE email = ?`, [req.user.email], (err, updatedUser) => {
                        res.json({ success: true, balance: updatedUser.balance, message: "Referral code applied successfully! $0.05 added." });
                    });
                });
            });
        });
    });
});

// 8. DAILY BONUS (Strict 1 Time Per Day Server-Side Check)
app.post('/api/claim-bonus', authenticateToken, (req, res) => {
    const today = new Date().toISOString().slice(0, 10);

    db.get(`SELECT last_bonus_date, balance FROM users WHERE email = ?`, [req.user.email], (err, user) => {
        if (err || !user) return res.status(400).json({ error: "User not found" });
        if (user.last_bonus_date === today) {
            return res.status(400).json({ error: "Already claimed daily bonus today!" });
        }

        db.serialize(() => {
            db.run(`BEGIN TRANSACTION`);
            db.run(`UPDATE users SET balance = balance + 0.01, last_bonus_date = ? WHERE email = ?`, [today, req.user.email]);
            db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, [req.user.email, 'DAILY BONUS', 0.01, 'Claimed Daily Login Bonus', 'APPROVED'], (err) => {
                if (err) {
                    db.run(`ROLLBACK`);
                    return res.status(500).json({ error: "Failed to claim bonus" });
                }
                db.run(`COMMIT`);
                db.get(`SELECT balance FROM users WHERE email = ?`, [req.user.email], (err, updatedUser) => {
                    res.json({ success: true, balance: updatedUser.balance, message: "Successfully claimed $0.01 Daily Bonus!" });
                });
            });
        });
    });
});

// 9. SUBMIT DEPOSIT
app.post('/api/deposit', authenticateToken, (req, res) => {
    const { amount, txId } = req.body;
    if (!amount || amount < 1 || !txId) return res.status(400).json({ error: "Minimum deposit $1.00 and TxID required" });

    db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, [req.user.email, 'CRYPTO DEPOSIT', amount, `TxID: ${txId.trim()}`, 'PENDING'], function(err) {
        if (err) return res.status(500).json({ error: "Failed to submit deposit" });
        res.json({ success: true, message: "Deposit submitted successfully!" });
    });
});

app.get('/api/countries', authenticateToken, async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/guest/countries`);
        res.json(response.data);
    } catch (error) { res.status(500).json({ error: "Failed to fetch countries" }); }
});

app.get('/api/services', authenticateToken, async (req, res) => {
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

app.get('/api/operators', authenticateToken, async (req, res) => {
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
                cost: rawCost * ADMIN_MARGIN,
                count: opDetails.count || 0
            });
        }
        res.json(operatorsList);
    } catch (error) { res.json([]); }
});

// 10. ATOMIC NUMBER PURCHASE WITH WALLET DEDUCTION
app.post('/api/buy', authenticateToken, buyLimiter, async (req, res) => {
    const { country, service, operator } = req.body;
    const selectedOp = operator || 'any';

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

        db.get(`SELECT balance FROM users WHERE email = ?`, [req.user.email], async (err, user) => {
            if (err || !user) return res.status(400).json({ error: "User not found" });
            if (user.balance < finalPrice) return res.status(400).json({ error: "Insufficient wallet balance!" });

            try {
                const response = await axios.get(`${BASE_URL}/user/buy/activation/${country}/${selectedOp}/${service}`, { headers });
                const orderId = response.data.id.toString();
                const phone = response.data.phone;

                db.serialize(() => {
                    db.run(`BEGIN TRANSACTION`);
                    db.run(`UPDATE users SET balance = balance - ? WHERE email = ?`, [finalPrice, req.user.email]);
                    db.run(`INSERT INTO orders (id, user_email, service, phone, status, code) VALUES (?, ?, ?, ?, ?, ?)`, [orderId, req.user.email, service, phone, 'WAITING', '-']);
                    db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, [req.user.email, 'NUMBER PURCHASE', finalPrice, `Service: ${service} (${phone}) [Op: ${selectedOp}]`, 'APPROVED'], (err) => {
                        if (err) {
                            db.run(`ROLLBACK`);
                            return res.status(500).json({ error: "Order processing failed" });
                        }
                        db.run(`COMMIT`);
                        res.json({ id: orderId, phone });
                    });
                });
            } catch (buyErr) {
                res.status(500).json({ error: "Number currently out of stock from provider." });
            }
        });
    } catch (error) { res.status(500).json({ error: "Process failed." }); }
});

app.get('/api/history', authenticateToken, (req, res) => {
    db.all(`SELECT type as category, amount as cost, details as info, status, created_at FROM transactions WHERE user_email = ? 
            UNION ALL 
            SELECT 'NUMBER ORDER' as category, 0 as cost, 'Service: ' || service || ' | Phone: ' || phone || ' | Status: ' || status as info, status, created_at FROM orders WHERE user_email = ? 
            ORDER BY created_at DESC`, [req.user.email, req.user.email], (err, rows) => {
        if (err) return res.status(500).json({ error: "Failed to fetch history" });
        res.json(rows);
    });
});

// 11. SECURE CHECK ORDER (Ensures user can only check their own orders)
app.get('/api/check/:id', authenticateToken, (req, res) => {
    const orderId = req.params.id;

    db.get(`SELECT * FROM orders WHERE id = ? AND user_email = ?`, [orderId, req.user.email], async (err, order) => {
        if (err || !order) return res.status(403).json({ error: "Unauthorized or order not found" });
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

// 12. SECURE CANCEL ORDER (Ensures user owns order & refunds atomically)
app.get('/api/cancel/:id', authenticateToken, (req, res) => {
    const orderId = req.params.id;

    db.get(`SELECT * FROM orders WHERE id = ? AND user_email = ? AND status = 'WAITING'`, [orderId, req.user.email], async (err, order) => {
        if (err || !order) return res.status(403).json({ error: "Unauthorized or order cannot be canceled" });

        try {
            const response = await axios.get(`${BASE_URL}/user/cancel/${orderId}`, { headers });
            
            // Find how much was deducted for this order
            db.get(`SELECT amount FROM transactions WHERE user_email = ? AND details LIKE ?`, [req.user.email, `%${order.phone}%`], (err, tx) => {
                const refundAmount = tx ? tx.amount : 0;

                db.serialize(() => {
                    db.run(`BEGIN TRANSACTION`);
                    db.run(`UPDATE orders SET status = 'REFUNDED' WHERE id = ?`, [orderId]);
                    if (refundAmount > 0) {
                        db.run(`UPDATE users SET balance = balance + ? WHERE email = ?`, [refundAmount, req.user.email]);
                        db.run(`INSERT INTO transactions (user_email, type, amount, details, status) VALUES (?, ?, ?, ?, ?)`, [req.user.email, 'REFUND', refundAmount, `Refund for order ${orderId}`, 'APPROVED']);
                    }
                    db.run(`COMMIT`);
                    res.json({ status: response.data.status });
                });
            });
        } catch (error) { res.status(500).json({ error: "Cancel failed" }); }
    });
});

app.listen(3000, () => console.log('Secure Enterprise Server running on port 3000'));
