require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY;
const BASE_URL = 'https://5sim.net/v1';
const headers = { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' };

app.get('/api/balance', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/user/profile`, { headers });
        res.json({ balance: response.data.balance });
    } catch (error) { res.status(500).json({ error: "Balance fetch failed" }); }
});

app.get('/api/price', async (req, res) => {
    const { country, service } = req.query;
    try {
        const response = await axios.get(`${BASE_URL}/guest/prices?country=${country}&product=${service}`);
        const priceData = response.data[country][service];
        const operatorKey = Object.keys(priceData)[0]; 
        res.json({ price: priceData[operatorKey].cost });
    } catch (error) { res.status(500).json({ error: "Price check failed" }); }
});

app.post('/api/buy', async (req, res) => {
    const { country, service } = req.body;
    try {
        const response = await axios.get(`${BASE_URL}/user/buy/activation/${country}/any/${service}`, { headers });
        res.json({ id: response.data.id, phone: response.data.phone });
    } catch (error) { res.status(500).json({ error: "Buy failed" }); }
});

app.get('/api/check/:id', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/user/check/${req.params.id}`, { headers });
        const sms = response.data.sms;
        if (sms && sms.length > 0) {
            res.json({ status: 'RECEIVED', code: sms[0].code });
        } else {
            res.json({ status: 'WAITING' });
        }
    } catch (error) { res.status(500).json({ error: "Check failed" }); }
});

app.get('/api/cancel/:id', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/user/cancel/${req.params.id}`, { headers });
        res.json({ status: response.data.status });
    } catch (error) { res.status(500).json({ error: "Cancel failed" }); }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));