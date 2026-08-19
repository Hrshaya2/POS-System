const http = require('http');

// Login to get token
const loginData = JSON.stringify({ email: 'admin@nangi.com', password: 'admin123' });
const loginReq = http.request({
    host: 'localhost', port: 5000, path: '/api/auth/login', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginData) }
}, res => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
        console.log('LOGIN STATUS:', res.statusCode);
        const parsed = JSON.parse(body);
        if (parsed.token) {
            console.log('Login successful, testing dashboard...');
            testDashboard(parsed.token);
        } else {
            console.log('Login failed:', body);
        }
    });
});
loginReq.on('error', e => console.log('LOGIN ERROR:', e.message));
loginReq.write(loginData);
loginReq.end();

function testDashboard(token) {
    const req = http.request({
        host: 'localhost', port: 5000, path: '/api/dashboard', method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
    }, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
            console.log('DASHBOARD STATUS:', res.statusCode);
            try {
                const parsed = JSON.parse(body);
                if (parsed.error) {
                    console.log('DASHBOARD ERROR:', parsed.error);
                } else {
                    console.log('DASHBOARD SUCCESS - keys:', Object.keys(parsed));
                    console.log('stats:', JSON.stringify(parsed.stats));
                    console.log('repairStatusCounts:', JSON.stringify(parsed.repairStatusCounts));
                    console.log('recentSales length:', parsed.recentSales?.length);
                    console.log('deadStockList length:', parsed.deadStockList?.length);
                    console.log('salesTrend length:', parsed.salesTrend?.length);
                }
            } catch (e) {
                console.log('RAW:', body.substring(0, 500));
            }
        });
    });
    req.on('error', e => console.log('DASHBOARD REQUEST ERROR:', e.message));
    req.end();
}