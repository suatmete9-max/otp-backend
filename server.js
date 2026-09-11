app.post('/api/buy', async (req, res) => {
    const { country, service, email } = req.body;
    try {
        const pricesRes = await axios.get(`${BASE_URL}/guest/prices?country=${country}&product=${service}`);
        const priceData = pricesRes.data[country] ? pricesRes.data[country][service] : null;
        
        if (!priceData) {
            return res.status(400).json({ error: "Service currently out of stock for this country." });
        }

        let cheapestOperator = 'any';
        let lowestPrice = Infinity;
        for (const [opName, opDetails] of Object.entries(priceData)) {
            if (opDetails.cost < lowestPrice && opDetails.count > 0) {
                lowestPrice = opDetails.cost;
                cheapestOperator = opName;
            }
        }

        if (lowestPrice === Infinity) {
            return res.status(400).json({ error: "No active operators with stock available." });
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
                res.status(500).json({ error: "Number out of stock from provider." });
            }
        });
    } catch (error) { res.status(500).json({ error: "Process failed or out of stock." }); }
});
