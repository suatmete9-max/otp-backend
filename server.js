require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const app = express();

app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY || "YOUR_5SIM_API_KEY"; // Yahan apni 5sim key daal sakte hain ya Render par env variable bana sakte hain
const BASE_URL = 'https://5sim.net/v1';
const headers = { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' };

const ADMIN_MARGIN = 1.3; // 30% Profit Margin

// Database setup
const db = new sqlite3.Database('./otp_database.db', (err) => {
    if (err) console.error('Database error', err);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, balance REAL DEFAULT 0.0)`);
    db.run(`CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, user_email TEXT, service TEXT, phone TEXT, status TEXT, code TEXT)`);
});

app.post('/api/signup', (req, res) => {
    const { email, password } = req.body;
    db.run(`INSERT INTO users (email, password) VALUES (?, ?)`, [email, password], function(err) {
        if (err) return res.status(400).json({ error: "Email already registered!" });
        res.json({ success: true, email });
    });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ? AND password = ?`, [email, password], (err, row) => {
        if (err || !row) return res.status(400).json({ error: "Invalid email or password!" });
        res.json({ success: true, email: row.email, balance: row.balance });
    });
});

app.get('/api/balance', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/user/profile`, { headers });
        res.json({ balance: response.data.balance });
    } catch (error) { res.status(500).json({ error: "Balance fetch failed" }); }
});

app.get('/api/countries', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/guest/countries`);
        res.json(response.data);
    } catch (error) { res.status(500).json({ error: "Failed" }); }
});

app.get('/api/services', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/guest/products`);
        res.json(response.data);
    } catch (error) { res.status(500).json({ error: "Failed" }); }
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
        const response = await axios.get(`${BASE_URL}/user/buy/activation/${country}/${cheapestOperator}/${service}`, { headers });
        const orderId = response.data.id.toString();
        const phone = response.data.phone;
        db.run(`INSERT INTO orders (id, user_email, service, phone, status, code) VALUES (?, ?, ?, ?, ?, ?)`, [orderId, email || 'guest', service, phone, 'WAITING', '-']);
        res.json({ id: orderId, phone });
    } catch (error) { res.status(500).json({ error: "Buy failed" }); }
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
