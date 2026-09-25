const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

class DashboardServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });
        this.port = process.env.PORT || 3000;

        this.botStatus = 'DISCONNECTED';
        this.qrDataUrl = null;
        this.connectedPhone = null;
        this.startTime = Date.now();

        this.analytics = {
            total: 0,
            operations: 0,
            revenue: 0,
            cities: {}
        };

        this.logs = [];
        this.onResetSessionCallback = null;

        this.initExpress();
        this.initWebSockets();
    }

    initExpress() {
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, 'public')));

        // API Endpoint: Get Current State
        this.app.get('/api/admin/state', (req, res) => {
            res.json({
                status: this.botStatus,
                qrDataUrl: this.qrDataUrl,
                connectedPhone: this.connectedPhone,
                uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
                analytics: this.analytics,
                logs: this.logs.slice(-30)
            });
        });

        // API Endpoint: Force Reset Session
        this.app.post('/api/admin/reset-session', (req, res) => {
            this.addLog('WARN', 'Admin requested Session Reset from Web Dashboard');
            if (this.onResetSessionCallback) {
                this.onResetSessionCallback();
            }
            res.json({ success: true, message: 'Session reset initiated' });
        });
    }

    initWebSockets() {
        this.wss.on('connection', (ws) => {
            console.log('🌐 Web Dashboard connected via WebSocket');

            // Send initial state on connection
            ws.send(JSON.stringify({
                type: 'INIT',
                payload: {
                    status: this.botStatus,
                    qrDataUrl: this.qrDataUrl,
                    connectedPhone: this.connectedPhone,
                    uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
                    analytics: this.analytics,
                    logs: this.logs.slice(-30)
                }
            }));
        });
    }

    broadcast(type, payload) {
        const message = JSON.stringify({ type, payload });
        this.wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }

    /**
     * Broadcast QR Code Data URL to all connected dashboard browsers
     */
    async updateQR(qrString) {
        this.botStatus = 'AWAITING_QR_SCAN';
        try {
            this.qrDataUrl = await QRCode.toDataURL(qrString, { margin: 2, width: 280 });
        } catch (err) {
            console.error('Error generating QR code data URL:', err);
            this.qrDataUrl = null;
        }

        this.addLog('INFO', 'New QR Code generated for WhatsApp linking');
        this.broadcast('QR_UPDATE', {
            status: this.botStatus,
            qrDataUrl: this.qrDataUrl
        });
    }

    /**
     * Update Bot Status (ONLINE / DISCONNECTED)
     */
    updateStatus(status, phone = null) {
        this.botStatus = status;
        if (status === 'ONLINE') {
            this.qrDataUrl = null;
            if (phone) this.connectedPhone = phone;
            this.addLog('SUCCESS', `WhatsApp Bot connected ONLINE (${this.connectedPhone || 'WhatsApp'})`);
        } else if (status === 'DISCONNECTED') {
            this.addLog('WARN', 'WhatsApp Bot disconnected from phone');
        }

        this.broadcast('STATUS_UPDATE', {
            status: this.botStatus,
            qrDataUrl: this.qrDataUrl,
            connectedPhone: this.connectedPhone
        });
    }

    /**
     * Record a new complaint in analytics
     */
    recordComplaint(c) {
        this.analytics.total++;

        const category = String(c.category || '').toUpperCase();
        const typeName = String(c.complaintTypeName || '').toLowerCase();
        const typeId = Number(c.complaintTypeId || 0);

        if (typeId === 1 || category === 'REVENUE' || typeName.includes('revenue') || typeName.includes('bill')) {
            this.analytics.revenue++;
        } else {
            // All water supply & sewerage complaints fall under Operations (complaintTypeId = 2)
            this.analytics.operations++;
        }

        const city = c.cityName || 'Lahore';
        this.analytics.cities[city] = (this.analytics.cities[city] || 0) + 1;

        const ticketSubtype = c.complaintSubtypeName || c.complaintTypeName || 'Complaint';
        this.addLog('COMPLAINT', `New Ticket #${c.complaintId || 'Registered'} registered for ${city} (${ticketSubtype})`);

        this.broadcast('ANALYTICS_UPDATE', {
            analytics: this.analytics
        });
    }

    /**
     * Add log entry and stream to dashboard
     */
    addLog(level, message) {
        const entry = {
            id: Date.now(),
            time: new Date().toLocaleTimeString(),
            level,
            message
        };

        this.logs.push(entry);
        if (this.logs.length > 100) this.logs.shift();

        this.broadcast('LOG_ENTRY', entry);
    }

    start() {
        if (this.isListening) return;

        this.server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.warn(`⚠️ Port ${this.port} is already in use by another process. Trying port ${this.port + 1}...`);
                this.port++;
                setTimeout(() => {
                    this.server.listen(this.port);
                }, 500);
            } else {
                console.error('⚠️ Dashboard server error:', err.message);
            }
        });

        this.server.listen(this.port, () => {
            this.isListening = true;
            console.log(`\n==================================================`);
            console.log(`🖥️  WEB ADMIN DASHBOARD IS RUNNING!`);
            console.log(`👉 Open in your browser: http://localhost:${this.port}/`);
            console.log(`==================================================\n`);
        });
    }
}

module.exports = new DashboardServer();
