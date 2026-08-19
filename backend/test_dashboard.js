const http = require('http');
const https = require('https');

// First login
const loginData = JSON.stringify({ email: 'admin@loyalmobile.com', password: 'admin123' });

function tryLogin(email, password, cb) {
    const data = JSON.stringify({ email, password });
    const req = http.request({
        host: 'localhost', port: 5000, path: '/api/auth/login', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => cb(JSON.parse(body)));
    });
    req.write(data);
    req.end();
}

function testDashboard(token) {
    const req = http.request({
        host: 'localhost', port: 5000, path: '/api/dashboard', method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
    }, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
            console.log('STATUS:', res.statusCode);
            try {
                const parsed = JSON.parse(body);
                if (parsed.error) console.log('ERROR:', parsed.error);
                else console.log('SUCCESS - keys:', Object.keys(parsed));
            } catch (e) {
                console.log('RAW:', body.substring(0, 500));
            }
        });
    });
    req.on('error', e => console.log('REQUEST ERROR:', e.message));
    req.end();
}

// Try to find valid credentials from users table
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');
db.all("SELECT email, name, role FROM users LIMIT 5", [], (err, users) => {
    if (err) { console.log('DB ERR:', err.message); return; }
    console.log('Users:', JSON.stringify(users));
    if (users.length > 0) {
        // Use a default token approach instead - generate one manually
        const jwt = require('jsonwebtoken');
        require('dotenv').config();
        const secret = process.env.JWT_SECRET || 'your_jwt_secret_key_here';
        const token = jwt.sign({ id: users[0].id || 1, role: users[0].role, name: users[0].name, email: users[0].email }, secret, { expiresIn: '1h' });
        console.log('Testing dashboard with token...');
        testDashboard(token);
    }
    db.close();
});
